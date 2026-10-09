"""VoxCPM-0.5B (OpenBMB, Apache-2.0) on GPU (fp16) when it fits in free VRAM, else CPU.

It clones by *continuing* the voice sample, so it needs the sample's exact transcript (ref_text).
VoxCPM 1.x has no emotion / style / energy control on a cloned voice (the delivery follows the sample
and the text), so those request fields are ignored. Speed and pitch are done by the app afterwards."""
import gc
import os
import random
import sys

os.environ.setdefault("TQDM_DISABLE", "1")  # keep per-step progress bars out of worker.log

import numpy as np
import torch

from base import serve

MODEL = "openbmb/VoxCPM-0.5B"
_m: dict = {}
_voice: dict = {}  # the last voice only: {(ref path, mtime, transcript): encoded prompt}


def _build(device: str, dtype: str):
    import voxcpm.model.voxcpm as vm
    from huggingface_hub import snapshot_download
    from voxcpm import VoxCPM

    # config.json asks for bfloat16 (no GTX 16xx support, and slow on CPU): float16 on the GPU, float32 on CPU.
    vm.pick_runtime_dtype = lambda dev, configured: dtype
    try:
        path = snapshot_download(MODEL, local_files_only=True)  # offline after the first download
    except Exception:  # noqa: BLE001
        path = snapshot_download(MODEL, allow_patterns=["*.json", "*.bin", "*.pth"])
    # optimize=False: no torch.compile (CUDA + triton only). enable_denoiser=False: no ZipEnhancer / modelscope.
    return VoxCPM(path, enable_denoiser=False, optimize=False, device=device).tts_model


def load() -> dict:
    torch.set_num_threads(int(os.environ.get("VOICECLONER_THREADS", "6")))
    from voxcpm.utils.text_normalize import TextNormalizer

    _m["norm"] = TextNormalizer().normalize  # numbers, dates, money -> words (model card: keep ON for plain text)
    try:
        if torch.cuda.is_available():
            free, _ = torch.cuda.mem_get_info()
            need = 640e6 * 2 + 100e6 + 350e6  # ~0.64B params in fp16 + fp32 VAE + KV cache / activations
            if free - need >= 250 * 2**20:
                _m["tts"] = _build("cuda", "float16")
                _m["gpu"] = True
                print(f"GPU: whole model fp16 on cuda ({free >> 20} MB was free)", file=sys.stderr)
                return {"device": "GPU"}
            print(f"GPU: only {free >> 20} MB free, need {(need >> 20) + 250} MB -> CPU", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"GPU setup failed, using CPU: {e}", file=sys.stderr)
        _m.pop("tts", None)
        torch.cuda.empty_cache()
    _m["tts"] = _build("cpu", "float32")
    return {"device": "CPU"}


def _to_cpu(why: str):
    print(f"GPU disabled for the rest of the session: {why}", file=sys.stderr)
    _m.pop("tts", None)
    _voice.clear()
    gc.collect()
    torch.cuda.empty_cache()
    _m["tts"] = _build("cpu", "float32")
    _m["gpu"] = False


def speak(req: dict):
    ref, ref_text = req["ref"], (req.get("ref_text") or "").strip()
    if not ref_text:
        raise ValueError("VoxCPM needs the transcript of the voice sample.")
    seed = int(req.get("seed") or 0) % 2**32
    for attempt in (0, 1):
        on_gpu = _m.get("gpu", False)
        try:
            tts, norm = _m["tts"], _m["norm"]
            key = (ref, os.path.getmtime(ref), ref_text)
            if key not in _voice:
                _voice.clear()
                # the model reads transcript + new text as one passage, so keep a space between them
                _voice[key] = tts.build_prompt_cache(prompt_text=norm(ref_text) + " ", prompt_wav_path=ref)
            random.seed(seed)
            np.random.seed(seed)
            torch.manual_seed(seed)  # the only randomness is the diffusion start noise
            torch.cuda.manual_seed_all(seed)
            wav, _, _ = tts.generate_with_prompt_cache(
                target_text=norm(req["text"]),
                prompt_cache=_voice[key],
                cfg_value=2.0, inference_timesteps=10,           # recommended defaults; cfg is text adherence, not energy
                retry_badcase=True, retry_badcase_max_times=2,   # 2 attempts = at most ONE retry when it fails to stop
            )
            out = wav.squeeze(0).float().cpu().numpy().astype(np.float32)
            if on_gpu and (not np.isfinite(out).all() or np.abs(out).max() < 1e-4):
                raise ValueError("non-finite or silent GPU output")
            return out, tts.sample_rate
        except Exception as e:  # noqa: BLE001
            if not on_gpu:
                raise
            _to_cpu(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    serve(load, speak)
