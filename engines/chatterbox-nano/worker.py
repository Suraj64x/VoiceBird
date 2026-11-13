"""Chatterbox-Nano (Resemble AI, 2026), loaded through ChatterboxTurboTTS(nano=True). Only real knob: temperature.
Nano has no exaggeration / cfg (the library ignores them), no style prompt and no reference transcript, so energy,
emotion, style and ref_text are ignored. Sound-event tags typed in the text ([laugh], [sigh], ...) pass through."""
import copy
import os
import random
import sys
from pathlib import Path

os.environ.setdefault("TQDM_DISABLE", "1")  # one progress bar per sentence would flood worker.log

import numpy as np
import torch

from base import lerp, serve, model_path

REPO = "ResembleAI/chatterbox-nano"
# Only what Nano loads; the repo's 1 GB s3gen.safetensors is not used by this model.
FILES = ["t3_nano_v1.safetensors", "s3gen_meanflow.safetensors", "ve.safetensors", "conds.pt", "vocab.json",
         "merges.txt", "added_tokens.json", "special_tokens_map.json", "tokenizer_config.json"]
model = None
voices = {}  # (ref path, mtime) -> Conditionals (speaker embedding + prompt tokens)


def fetch() -> str:
    """The model files (downloaded once, then offline; see base.model_path)."""
    return model_path(REPO, FILES)


def load():
    global model
    torch.set_num_threads(int(os.environ.get("VOICECLONER_THREADS", "6")))
    ckpt = Path(fetch())
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    model = ChatterboxTurboTTS.from_local(ckpt, "cpu", nano=True)
    return {"device": _gpu_setup()}


class T3Proxy:
    """T3 as an fp16 GPU copy next to the untouched fp32 CPU original (kept for the fallback)."""

    def __init__(self, cpu, gpu):
        self.cpu, self.gpu = cpu, gpu

    def __getattr__(self, name):
        return getattr(self.gpu or self.cpu, name)

    def inference_turbo(self, t3_cond, text_tokens, **kw):
        m = self.gpu or self.cpu
        p = next(m.parameters())
        cond = copy.copy(t3_cond).to(device=p.device, dtype=p.dtype)
        out = m.inference_turbo(t3_cond=cond, text_tokens=text_tokens.to(p.device), **kw)
        return out.to(model.device)


def _nbytes(m, per):
    return sum(p.numel() for p in m.parameters()) * per


def _gpu_setup() -> str:
    """T3 (fp16) on the GPU if it fits; then S3Gen (fp32, its vocoder/flow stay full precision) if that fits too."""
    try:
        if not torch.cuda.is_available():
            return "CPU"
        free, _ = torch.cuda.mem_get_info()
        keep = 250 * 2**20 + 150 * 2**20  # headroom + activations
        t3_need, s3_need = _nbytes(model.t3, 2), _nbytes(model.s3gen, 4)
        if free - keep < t3_need:
            print(f"GPU: only {free >> 20} MB free, T3 needs {t3_need >> 20} MB -> CPU", file=sys.stderr)
            return "CPU"
        model.t3 = T3Proxy(model.t3, copy.deepcopy(model.t3).half().to("cuda").eval())
        dev = "GPU+CPU"
        if free - keep - t3_need >= s3_need:
            model.s3gen.to("cuda")
            model.device = "cuda"
            dev = "GPU"
        print(f"GPU: T3 fp16 on cuda, S3Gen on {model.device} ({free >> 20} MB was free)", file=sys.stderr)
        return dev
    except Exception as e:  # noqa: BLE001
        print(f"GPU setup failed, using CPU: {e}", file=sys.stderr)
        return "CPU"


def _drop_gpu(why: str):
    print(f"GPU disabled for the rest of the session: {why}", file=sys.stderr)
    if isinstance(model.t3, T3Proxy):
        model.t3.gpu = None
    model.s3gen.to("cpu")
    model.device = "cpu"
    voices.clear()  # cached voices hold GPU tensors
    torch.cuda.empty_cache()


def speak(req):
    temperature = round(lerp(0.5, 1.1, float(req.get("variation", 0.5))), 3)  # 0.8 (library default) at 0.5
    seed = int(req.get("seed", 0))
    print(f"speak seed={seed} temperature={temperature} chars={len(req['text'])}", flush=True)
    for attempt in (0, 1):
        on_gpu = isinstance(model.t3, T3Proxy) and model.t3.gpu is not None
        try:
            key = (req["ref"], os.path.getmtime(req["ref"]))
            if key not in voices:
                model.prepare_conditionals(req["ref"])
                voices[key] = model.conds
            model.conds = voices[key]
            random.seed(seed)
            np.random.seed(seed % 2**32)
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            out = model.generate(req["text"], temperature=temperature).squeeze(0).numpy().astype(np.float32)
            if on_gpu and (not np.isfinite(out).all() or np.abs(out).max() < 1e-4):
                raise ValueError("non-finite or silent GPU output")
            return out, model.sr
        except Exception as e:  # noqa: BLE001
            if not on_gpu:
                raise
            _drop_gpu(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    serve(load, speak)
