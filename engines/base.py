"""Shared by every engine worker (engines/<id>/worker.py). Needs only numpy + soundfile.

Protocol: one JSON object per line.
  worker -> server, once:   {"ready": true, "device": "GPU" | "CPU"}      (or {"ready": false, "error": "..."})
  server -> worker:         {"text", "ref", "ref_text", "out", "seed", "emotion", "energy", "style", "variation"}
  worker -> server:         {"ok": true, "sr": 24000, "seconds": 3.2}     (or {"ok": false, "error": "..."})

  text       what to say (one or two sentences)
  ref        path of the voice sample (mono 44.1 kHz WAV), ref_text = what is said in it
  out        where to write the result (WAV)
  seed       int; same seed + same inputs must give the same audio
  emotion    neutral | friendly | excited | calm | serious | sad | angry | whisper
  energy     0..1, how animated the delivery should be (already scaled by the Intensity slider)
  style      free-text style prompt ("hyped YouTube host, smiling"), may be empty
  variation  0..1, expressiveness / randomness

A worker is just:   from base import serve;  serve(load, speak)
  load()      -> {"device": "GPU"}          load the model once
  speak(req)  -> (mono float32 numpy array, sample_rate)
"""
import json
import os
import sys
import traceback


def serve(load, speak) -> None:
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8")  # the real stdout is reserved for the protocol
    os.dup2(2, 1)                                        # anything a library prints goes to the log instead
    sys.stdout = sys.stderr

    def send(obj: dict) -> None:
        proto.write(json.dumps(obj) + "\n")
        proto.flush()

    try:
        info = load() or {}
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        return send({"ready": False, "error": f"Could not load the voice model: {e}"})
    send({"ready": True, **info})

    import soundfile as sf
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            wav, sr = speak(req)
            sf.write(req["out"], wav, sr, subtype="FLOAT")
            send({"ok": True, "sr": sr, "seconds": len(wav) / sr})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            send({"ok": False, "error": f"{type(e).__name__}: {e}"})


def lerp(lo: float, hi: float, t: float) -> float:
    return lo + (hi - lo) * max(0.0, min(1.0, t))
