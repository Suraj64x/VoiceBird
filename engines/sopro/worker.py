"""Sopro v2 Turbo (samuel-vitorino/sopro-v2-turbo, Apache-2.0): zero-shot cloning from the voice sample alone.

Real knobs only: variation -> temperature / top_p. Sopro has no emotion, energy or style input (delivery follows
the voice sample), so emotion / energy / style / ref_text are ignored."""
import os

import torch
from base import lerp, serve, model_path

REPO = "samuel-vitorino/sopro-v2-turbo"
# Flow-matching solver steps for the mel head. Author default is 2 (fastest); 8/16/32 trade speed for similarity.
STEPS = int(os.environ.get("VOICECLONER_SOPRO_STEPS", "8"))
tts = None
_ref = {}  # (path, mtime) -> prepared reference (speaker embedding + prompt tokens + mel); one voice at a time


def fetch() -> str:
    """The model files (downloaded once, then offline; see base.model_path)."""
    from sopro.hub import ARTIFACT_FILES
    return model_path(REPO, list(ARTIFACT_FILES))


def load():
    global tts
    torch.set_num_threads(int(os.environ.get("VOICECLONER_THREADS", "6")))
    from sopro import SoproTTS
    tts = SoproTTS.from_pretrained(fetch())
    return {"device": "CPU"}


def speak(req):
    key = (req["ref"], os.path.getmtime(req["ref"]))
    if key not in _ref:
        torch.manual_seed(0)  # prepare_reference can add random room tone; keep it independent of the request seed
        _ref.clear()
        _ref[key] = tts.prepare_reference(ref_audio_path=req["ref"])
    torch.manual_seed(int(req.get("seed", 0)) % 2**32)  # torch is the only RNG sopro uses (multinomial + randn)
    v = float(req.get("variation", 0.5))
    wav = tts.synthesize(req["text"], ref=_ref[key], lang="en", steps=STEPS,
                         temperature=lerp(0.6, 1.0, v), top_p=lerp(0.8, 1.0, v))  # 0.5 -> sopro defaults 0.8 / 0.9
    return wav.cpu().numpy().astype("float32"), tts.sample_rate


if __name__ == "__main__":
    serve(load, speak)
