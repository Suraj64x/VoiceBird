"""Qwen3-TTS-12Hz-0.6B-Base (Alibaba Qwen, Apache-2.0) on GPU (fp16) when it fits in free VRAM, else CPU (fp32).

It clones in-context: the sample's audio codes + its exact transcript (ref_text) go in front of the new text, so
timbre, pace and delivery follow the sample. Output is 24 kHz. The Base model has no emotion / style / energy
control on a cloned voice; variation sets the sampling temperature and emotion energy nudges it (livelier / steadier).

Three GTX 16xx fixes on top of the stock qwen-tts 0.1.1 package (pinned: they use its internals):
  1. fp16 overflows to inf in the small code predictor (15 sub-steps per frame), so that part runs in fp32.
  2. Those 15 sub-steps are launch-bound on Windows, so they are recorded once as a CUDA graph and replayed.
  3. Only the last 25 frames of the sample are decoded as context (the stock code decodes all of it every time)."""
import gc
import os
import random
import sys
from types import SimpleNamespace

os.environ.setdefault("TQDM_DISABLE", "1")

import numpy as np
import torch

from base import lerp, serve

MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
LANGUAGE = "English"  # ponytail: fixed; the app is English-only. Qwen3 also does zh/ja/ko/de/fr/ru/pt/es/it.
CONTEXT = 25          # sample frames decoded in front of the new speech (= the tokenizer's own chunk context)
_m: dict = {}
_voice: dict = {}  # the last voice only: {(ref path, mtime, transcript): voice clone prompt}


class GraphedCodePredictor:
    """Drop-in for talker.code_predictor.generate(): sampling (temperature + top-k) of all 15 sub-codes of one frame,
    recorded once as a CUDA graph. Anything it was not recorded for falls back to the stock HF generate()."""

    def __init__(self, cp, hidden: int, steps: int, top_k: int):
        from transformers import DynamicCache
        self.cp, self.hf, self.n, self.k, self.cache = cp, cp.generate, steps, top_k, DynamicCache
        p = next(cp.lm_head.parameters())
        self.x = torch.zeros(1, 2, hidden, dtype=p.dtype, device=p.device)
        self.t = torch.ones(1, device=p.device)
        s = torch.cuda.Stream()
        s.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(s), torch.inference_mode():
            for _ in range(2):  # warm-up outside the graph, as CUDA graphs require
                self._steps()
        torch.cuda.current_stream().wait_stream(s)
        self.g = torch.cuda.CUDAGraph()
        with torch.cuda.graph(self.g), torch.inference_mode():
            self.out = self._steps()

    def _steps(self):
        cache, ids, out = self.cache(), None, []
        for step in range(self.n):
            o = self.cp(inputs_embeds=self.x if step == 0 else None, input_ids=ids, past_key_values=cache,
                        use_cache=True, generation_steps=step)
            logits = o.logits[:, -1].float() / self.t
            logits = logits.masked_fill(logits < torch.topk(logits, self.k).values[:, -1:], float("-inf"))
            probs = torch.softmax(logits, -1)
            ids = (probs / torch.empty_like(probs).exponential_()).argmax(-1, keepdim=True)  # = multinomial, graph-safe
            out.append(ids)
        return torch.cat(out, 1)

    def __call__(self, inputs_embeds, max_new_tokens, do_sample=True, top_k=50, top_p=1.0, temperature=0.9, **kw):
        if not do_sample or top_p < 1.0 or top_k != self.k or max_new_tokens != self.n or inputs_embeds.shape != self.x.shape:
            return self.hf(inputs_embeds=inputs_embeds, max_new_tokens=max_new_tokens, do_sample=do_sample,
                           top_k=top_k, top_p=top_p, temperature=temperature, **kw)
        self.x.copy_(inputs_embeds)
        self.t.fill_(temperature)
        self.g.replay()
        return SimpleNamespace(sequences=self.out.clone())


def _gpu_fixes(tts) -> None:
    talker = tts.model.talker
    cp = talker.code_predictor.model  # fix 1: its 5 decoder layers + final norm in fp32 (+130 MB), fp16 in and out
    cp.layers.float()
    cp.norm.float()
    cp.layers[0].register_forward_pre_hook(
        lambda mod, a, k: ((a[0].float(), *a[1:]), k) if a else (a, {**k, "hidden_states": k["hidden_states"].float()}),
        with_kwargs=True)
    cp.norm.register_forward_hook(lambda mod, a, out: out.half())
    talker.code_predictor.generate = GraphedCodePredictor(  # fix 2
        talker.code_predictor, talker.config.hidden_size, talker.config.num_code_groups - 1,
        int(tts.generate_defaults.get("subtalker_top_k", 50)))


def _build(device: str, dtype):
    from huggingface_hub import snapshot_download
    from qwen_tts import Qwen3TTSModel

    try:
        path = snapshot_download(MODEL, local_files_only=True)  # offline after the first download
    except Exception:  # noqa: BLE001
        path = snapshot_download(MODEL)
    # sdpa: no flash-attn on Windows / GTX 16xx. The bundled speech tokenizer loads with the same device and dtype.
    tts = Qwen3TTSModel.from_pretrained(path, device_map=device, dtype=dtype, attn_implementation="sdpa")
    if device != "cpu":
        _gpu_fixes(tts)
    return tts


def load() -> dict:
    torch.set_num_threads(int(os.environ.get("VOICECLONER_THREADS", "6")))
    try:
        if torch.cuda.is_available():
            free, _ = torch.cuda.mem_get_info()
            need = 2.25e9 + 350e6  # weights (fp16, code predictor fp32) + KV cache / decoder activations
            if free - need >= 150 * 2**20:
                _m["tts"] = _build("cuda:0", torch.float16)
                _m["gpu"] = True
                print(f"GPU: fp16 on cuda ({free >> 20} MB was free)", file=sys.stderr)
                return {"device": "GPU"}
            print(f"GPU: only {free >> 20} MB free, need {(int(need) >> 20) + 150} MB -> CPU", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"GPU setup failed, using CPU: {e}", file=sys.stderr)
        _m.pop("tts", None)
        gc.collect()
        torch.cuda.empty_cache()
    _m["tts"] = _build("cpu", torch.float32)
    _m["gpu"] = False
    return {"device": "CPU"}


def _to_cpu(why: str):
    print(f"GPU disabled for the rest of the session: {why}", file=sys.stderr)
    _m.pop("tts", None)
    _voice.clear()
    gc.collect()
    torch.cuda.empty_cache()
    _m["tts"] = _build("cpu", torch.float32)
    _m["gpu"] = False


@torch.inference_mode()
def _generate(tts, text: str, prompt, temperature: float) -> tuple[np.ndarray, int]:
    """Qwen3TTSModel.generate_voice_clone() for one text, minus decoding the whole sample again (fix 3)."""
    codes, _ = tts.model.generate(
        input_ids=tts._tokenize_texts([tts._build_assistant_text(text)]),
        ref_ids=[tts._tokenize_texts([tts._build_ref_text(prompt[0].ref_text)])[0]],
        voice_clone_prompt=tts._prompt_items_to_voice_clone_prompt(prompt),
        languages=[LANGUAGE], non_streaming_mode=False,
        **tts._merge_generate_kwargs(temperature=temperature, subtalker_temperature=temperature,
                                     max_new_tokens=int(12.5 * (len(text) / 6 + 4))),  # runaway guard: ~6 chars/s + 4 s
    )
    ctx = prompt[0].ref_code[-CONTEXT:].to(codes[0].device)
    wavs, sr = tts.model.speech_tokenizer.decode([{"audio_codes": torch.cat([ctx, codes[0]])}])
    return np.asarray(wavs[0][len(ctx) * tts.model.speech_tokenizer.get_decode_upsample_rate():], np.float32), sr


def speak(req: dict):
    ref, ref_text = req["ref"], (req.get("ref_text") or "").strip()
    if not ref_text:
        raise ValueError("Qwen3 needs the transcript of the voice sample.")
    text = req["text"].strip()
    seed = int(req.get("seed") or 0) % 2**32
    # variation sets the base (0.9 = model default at 0.5); emotion energy adds liveliness: excited reads more animated, calm steadier
    temperature = round(min(1.3, max(0.5, lerp(0.6, 1.2, float(req.get("variation", 0.5))) + (float(req.get("energy", 0.5)) - 0.5) * 0.4)), 3)
    print(f"speak seed={seed} temperature={temperature} chars={len(text)}", flush=True)
    for attempt in (0, 1):
        on_gpu = _m.get("gpu", False)
        try:
            tts = _m["tts"]
            key = (ref, os.path.getmtime(ref), ref_text)
            if key not in _voice:
                _voice.clear()
                _voice[key] = tts.create_voice_clone_prompt(ref_audio=ref, ref_text=ref_text)
            random.seed(seed)
            np.random.seed(seed)
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            out, sr = _generate(tts, text, _voice[key], temperature)
            if on_gpu and (not np.isfinite(out).all() or np.abs(out).max() < 1e-4):
                raise ValueError("non-finite or silent GPU output")
            return out, sr
        except Exception as e:  # noqa: BLE001
            if not on_gpu:
                raise
            _to_cpu(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    serve(load, speak)
