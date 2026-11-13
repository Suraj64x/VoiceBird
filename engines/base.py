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


def model_path(repo: str, patterns: list | None = None) -> str:
    """Folder holding a model's files.

    VoiceBird keeps its own plain copy in <HF_HOME>/voicebird/<repo>: real files, no symlinks (some PCs block them).
    An existing Hugging Face cache is used as it is. Downloads resume where they stopped and retry with a growing pause.
    With VOICEBIRD_REFRESH=1 (setup and repair) every file of our copy is checked against the Hub again, so broken,
    incomplete or outdated files are fixed.
    """
    import time
    from pathlib import Path
    from huggingface_hub import snapshot_download
    home = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
    own = home / "voicebird" / repo.replace("/", "--")
    done = own / ".complete"
    refresh = os.environ.get("VOICEBIRD_REFRESH") == "1"
    if done.exists() and not refresh:
        return str(own)
    if not own.exists():
        try:  # a model that is already in the regular Hugging Face cache
            return snapshot_download(repo, allow_patterns=patterns, local_files_only=True)
        except Exception:  # noqa: BLE001
            pass
    if refresh and own.exists():  # repair: a file whose size differs from the Hub's is broken or outdated, fetch it again
        try:
            from fnmatch import fnmatch
            from huggingface_hub import HfApi
            for f in HfApi().model_info(repo, files_metadata=True).siblings:
                local = own / f.rfilename
                wanted = not patterns or any(fnmatch(f.rfilename, p) for p in patterns)
                if wanted and f.size is not None and local.exists() and local.stat().st_size != f.size:
                    print(f"{repo}: {f.rfilename} is damaged or outdated, downloading it again", file=sys.stderr, flush=True)
                    local.unlink()
        except Exception as e:  # noqa: BLE001  (offline: keep what we have)
            print(f"could not check the {repo} files: {e}", file=sys.stderr, flush=True)
    tries, err = int(os.environ.get("VOICEBIRD_TRIES", "6")), None
    for attempt in range(tries):
        try:
            snapshot_download(repo, allow_patterns=patterns, local_dir=own)
            done.write_text(time.strftime("%Y-%m-%d %H:%M"), encoding="utf-8")
            return str(own)
        except Exception as e:  # noqa: BLE001
            err = e
            print(f"download of {repo} stopped ({type(e).__name__}: {e}); try {attempt + 1} of {tries}", file=sys.stderr, flush=True)
            if attempt + 1 < tries:
                time.sleep(min(60, 5 * 2 ** attempt))
    raise RuntimeError(f"Could not download the {repo} model: {err}")


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
