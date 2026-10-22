"""Blind engine bake-off on the default voice (run from the app folder, app stopped or idle):

    .venv/Scripts/python -m tests.bakeoff gen      # every installed engine speaks the same lines, saved under blind codes
    .venv/Scripts/python -m tests.bakeoff score    # scores the blind folders (never looks at the engine names)
    .venv/Scripts/python -m tests.bakeoff reveal   # joins scores with the key -> samples/bakeoff/results.md

Metrics per clip: WER (Whisper medium.en), speaker similarity to the reference clip (speaker-verification
embedding, cosine), DNSMOS OVRL (signal quality, 1-5), and speed (RTF = seconds of compute per second of audio).

Decision rule, fixed before any results were seen:
  best quality  = highest mean similarity among engines with mean WER <= 5 % and OVRL within 0.3 of the best OVRL
  fast          = highest mean similarity among engines with RTF <= 1.5 (same WER / OVRL gates)
"""
import json
import random
import sys
import time
from pathlib import Path

from server import audio, engines
from server.app import _speak, delivery
from server.config import ROOT, VOICES

OUT = ROOT / "samples" / "bakeoff"
LINES = [  # kept short so the slow engines finish in minutes
    "Today I'm going to show you three open source tools that do the same job, and one of them is honestly better than the paid version.",
    "Sounds too good to be true, right? Stick around until the end, because the last one saved me hours of work every single week!",
]
CONDITIONS = {
    "neutral": {"emotion": "neutral", "intensity": 50, "style": "", "variation": 50},
    "excited": {"emotion": "excited", "intensity": 60, "style": "hyped YouTube host, smiling", "variation": 55},
}


def _voice() -> dict:
    return next(v for v in (json.loads(f.read_text(encoding="utf-8")) for f in VOICES.glob("*/voice.json")) if v["default"])


def gen(only: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    key_file = OUT / "key.json"
    key = json.loads(key_file.read_text()) if key_file.exists() else {}
    voice = _voice()
    for e in engines.installed():
        if only and e["id"] not in only:
            continue
        if e["id"] not in key:  # blind code: a random letter not used yet
            key[e["id"]] = random.choice([c for c in "ABCDEFGHJKLMNPQRSTUVWXYZ" if c not in key.values()])
            key_file.write_text(json.dumps(key, indent=1))
        d_out = OUT / key[e["id"]]
        d_out.mkdir(exist_ok=True)
        t = time.time()
        w = engines.ensure(e["id"])
        load = time.time() - t
        timing = {"load_s": round(load, 1), "clips": {}}
        for cond, settings in CONDITIONS.items():
            d = delivery(settings)
            base = {"ref": str(VOICES / voice["id"] / "ref.wav"), "ref_text": voice["transcript"],
                    **{k: d[k] for k in ("emotion", "energy", "style", "variation")}}
            for n, line in enumerate(LINES):
                t = time.time()
                try:
                    x, sr = _speak(w, {**base, "text": line, "seed": 1234 + n}, len(line))
                except Exception as err:  # noqa: BLE001
                    print(f"  {e['id']} {cond} {n}: FAILED {err}")
                    timing["clips"][f"{cond}-{n}"] = {"error": str(err)}
                    continue
                dt = time.time() - t
                audio.write(d_out / f"{cond}-{n}.wav", x, sr)
                timing["clips"][f"{cond}-{n}"] = {"gen_s": round(dt, 2), "audio_s": round(len(x) / sr, 2)}
                print(f"  {e['id']} {cond} {n}: {len(x) / sr:.1f} s audio in {dt:.1f} s (RTF {dt / (len(x) / sr):.2f})", flush=True)
        (d_out / "timing.json").write_text(json.dumps(timing, indent=1))
    engines.shutdown()


def score() -> None:
    from tests import quality
    ref = VOICES / _voice()["id"] / "ref.wav"
    for d in sorted(p for p in OUT.iterdir() if p.is_dir()):
        rows = {}
        for wav in sorted(d.glob("*.wav")):
            cond, n = wav.stem.rsplit("-", 1)
            w = quality.wer(wav, LINES[int(n)])
            rows[wav.stem] = {"wer": round(w["wer"], 4), "sim": round(quality.similarity(wav, ref), 4),
                              "ovrl": round(quality.dnsmos(wav)["ovrl"], 3), "hyp": w["hyp"]}
            print(d.name, wav.stem, rows[wav.stem]["wer"], rows[wav.stem]["sim"], rows[wav.stem]["ovrl"], flush=True)
        (d / "scores.json").write_text(json.dumps(rows, indent=1))


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else float("nan")


def table() -> list[dict]:
    """Per blind code + condition: mean WER / similarity / OVRL / RTF."""
    out = []
    for d in sorted(p for p in OUT.iterdir() if p.is_dir() and (p / "scores.json").exists()):
        scores, timing = json.loads((d / "scores.json").read_text()), json.loads((d / "timing.json").read_text())
        for cond in [*CONDITIONS, "all"]:
            ks = [k for k in scores if cond == "all" or k.startswith(cond + "-")]
            ts = [timing["clips"][k] for k in ks if "gen_s" in timing["clips"].get(k, {})]
            out.append({"code": d.name, "condition": cond, "clips": len(ks),
                        "failed": sum(1 for k, v in timing["clips"].items() if "error" in v and (cond == "all" or k.startswith(cond + "-"))),
                        "wer_pct": round(100 * _mean([scores[k]["wer"] for k in ks]), 2),
                        "sim": round(_mean([scores[k]["sim"] for k in ks]), 3),
                        "ovrl": round(_mean([scores[k]["ovrl"] for k in ks]), 2),
                        "rtf": round(sum(t["gen_s"] for t in ts) / max(0.01, sum(t["audio_s"] for t in ts)), 2),
                        "load_s": timing["load_s"]})
    return out


def reveal() -> None:
    key = {v: k for k, v in json.loads((OUT / "key.json").read_text()).items()}
    names = {e["id"]: e["name"] for e in engines.installed()}
    rows = table()
    (OUT / "results.json").write_text(json.dumps([{**r, "engine": key.get(r["code"], "?")} for r in rows], indent=1))
    md = ["| Code | Engine | Condition | WER % | Similarity | DNSMOS OVRL | RTF (lower = faster) | Failed |", "|---|---|---|---|---|---|---|---|"]
    md += [f"| {r['code']} | {names.get(key.get(r['code']), key.get(r['code'], '?'))} | {r['condition']} | {r['wer_pct']} | {r['sim']} | {r['ovrl']} | {r['rtf']} | {r['failed']} |" for r in rows]
    (OUT / "results.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "gen":
        gen(sys.argv[2:])
    elif cmd == "score":
        score()
    elif cmd == "table":
        print(json.dumps(table(), indent=1))
    elif cmd == "reveal":
        reveal()
    else:
        print(__doc__)
