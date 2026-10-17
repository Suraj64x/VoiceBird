"""Smoke-test one engine through the same worker protocol the app uses (run from the app folder):

    .venv/Scripts/python -m server.try_engine <engine-id> ["text to say" ...]

Loads the engine, speaks with the default voice, prints load time and speed, checks that the same seed
gives the same audio, and leaves the WAVs in engines/<id>/_test/."""
import json
import sys
import time

import numpy as np

from . import audio, engines
from .config import VOICES

TEXTS = ["Hello there! This is a quick test of my cloned voice.",
         "If you can hear this clearly, the engine is installed and working, which is great news for the next video."]


def main() -> int:
    eid, texts = sys.argv[1], sys.argv[2:] or TEXTS
    e = engines.get(eid)
    if e["id"] != eid:
        print(f"'{eid}' is not installed: engines/{eid}/ needs engine.json, worker.py and .venv/")
        return 1
    voice = next(v for v in (json.loads(f.read_text(encoding="utf-8")) for f in VOICES.glob("*/voice.json")) if v["default"])
    t = time.time()
    w = engines.ensure(eid)
    print(f"loaded {e['name']} in {time.time() - t:.1f} s on {w.info.get('device')}")
    out_dir = engines.ENGINES / eid / "_test"
    out_dir.mkdir(exist_ok=True)
    req = {"ref": str(VOICES / voice["id"] / "ref.wav"), "ref_text": voice["transcript"], "seed": 1234,
           "emotion": "friendly", "energy": 0.5, "style": "", "variation": 0.5}
    ok = True
    for i, text in enumerate(texts):
        t = time.time()
        r = w.call({**req, "text": text, "out": str(out_dir / f"{i}.wav")})
        dt = time.time() - t
        if not r.get("ok"):
            print(f"FAILED on text {i}: {r.get('error')}")
            ok = False
            continue
        print(f"text {i}: {r['seconds']:.1f} s of audio in {dt:.1f} s -> RTF {dt / r['seconds']:.2f} ({r['sr']} Hz)")
    if ok:  # same seed must repeat exactly (the app's "lock seed" relies on it)
        w.call({**req, "text": texts[0], "out": str(out_dir / "repeat.wav")})
        a, b = audio.read(out_dir / "0.wav")[0], audio.read(out_dir / "repeat.wav")[0]
        same = len(a) == len(b) and float(np.abs(a - b).max()) < 1e-3
        print("deterministic with a fixed seed:", same)
    engines.shutdown()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
