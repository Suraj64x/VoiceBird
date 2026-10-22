"""The "done means" test: a ~150-word script generated three ways through the running app, then measured.

    .venv/Scripts/python -m tests.run_quality <engine-id> [api base, default http://127.0.0.1:7879]

Writes samples/<engine>-<way>.mp3/.wav (YouTube masters) and samples/report-<engine>.json."""
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path

from server.config import ROOT, VOICES
from tests import quality

SCRIPT = """Most people pay every month for apps they could get for free. Today I'm going to show you three open source tools that do the same job, and one of them is honestly better than the paid version.

The first one is a screen recorder. It runs on Windows, Mac and Linux, it has no watermark, and it can record your webcam and your microphone at the same time. You install it in about a minute, and that's it.

The second tool edits audio. You can cut out silence, remove background noise, and export straight to MP3. I use it for every single video on this channel.

The last one replaces a design app that costs twenty dollars a month. It does layers, text and export to PNG, and it runs right in your browser. If this saved you some money, subscribe, and I'll see you in the next video."""

WAYS = {
    "neutral": {"emotion": "neutral", "intensity": 50, "style": "", "speed": 1.0, "pitch": 0},
    "excited": {"emotion": "excited", "intensity": 60, "style": "excited but natural, friendly YouTube host, smiling", "speed": 1.0, "pitch": 0},
    "calm": {"emotion": "calm", "intensity": 50, "style": "", "speed": 0.9, "pitch": -2},
}


def call(base: str, method: str, path: str, body=None):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=3600) as r:
        return json.loads(r.read())


def main() -> None:
    engine, base = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:7879") + "/api"
    paras = [p.strip() for p in SCRIPT.split("\n\n")]
    keys = [f"q{i}" for i in range(len(paras))]
    jason = Path(os.environ.get("SIMILARITY_REF", "-"))  # a clean clip of the real voice to compare against; else its ref.wav
    voice = next(v for v in (json.loads(f.read_text(encoding="utf-8")) for f in VOICES.glob("*/voice.json")) if v["default"])
    ref = jason if jason.exists() else VOICES / voice["id"] / "ref.wav"
    out_dir = ROOT / "samples"
    out_dir.mkdir(exist_ok=True)
    report = {"engine": engine, "voice": voice["name"], "words": len(SCRIPT.split()), "ways": {}}
    for way, s in WAYS.items():
        settings = {"voice": voice["id"], "engine": engine, "variation": 50, "seed": 1234, "lockSeed": True, "pause": 0.6, **s}
        p = call(base, "POST", "/projects", {"name": f"Quality test {engine} {way}", "script": SCRIPT, "settings": settings})
        t0 = time.time()
        call(base, "POST", f"/projects/{p['id']}/generate", {"items": [{"key": k, "text": t} for k, t in zip(keys, paras)], "settings": settings})
        while (job := call(base, "GET", "/status")["job"])["running"]:
            time.sleep(3)
        if job["error"]:
            raise SystemExit(f"{way}: {job['error']}")
        gen_s = time.time() - t0
        raw = call(base, "POST", f"/projects/{p['id']}/export", {"keys": keys, "wav": True, "mp3": False, "master": False, "pause": 0.6})
        mst = call(base, "POST", f"/projects/{p['id']}/export", {"keys": keys, "wav": True, "mp3": True, "master": True, "pause": 0.6})
        raw_dir, mst_dir = Path(raw["folder"]), Path(mst["folder"])
        raw_wav = next(raw_dir.glob("*.wav"))
        m = json.loads((raw_dir / "manifest.json").read_text(encoding="utf-8"))
        join_times = m["paragraph_joins"] + [j for para in m["paragraphs"] for j in para["sentence_joins"]]
        master_wav = next(mst_dir.glob("*-master.wav"))
        for f in mst_dir.glob("*-master.*"):
            shutil.copy(f, out_dir / f"{engine}-{way}{f.suffix}")
        w = quality.wer(master_wav, SCRIPT)
        j = quality.joins_summary(quality.joins(raw_wav, join_times, window_s=2.0))
        report["ways"][way] = {
            "wer_pct": round(100 * w["wer"], 2), "errors": w["errors"], "heard": w["hyp"],
            "similarity_to_jason": round(quality.similarity(master_wav, ref), 4),
            "joins": j, "loudness": quality.loudness(master_wav), "dnsmos": quality.dnsmos(master_wav),
            "generate_seconds": round(gen_s), "audio_seconds": round(m["paragraphs"][-1]["start"] + m["paragraphs"][-1]["duration"], 1),
            "sample": f"samples/{engine}-{way}.mp3",
        }
        call(base, "DELETE", f"/projects/{p['id']}")
        print(way, json.dumps({k: v for k, v in report["ways"][way].items() if k != "heard"}), flush=True)
    (out_dir / f"report-{engine}.json").write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
