"""Voice engines run as separate worker processes, one folder each under engines/<id>/:

    engine.json   name, licence, limits (see FIELDS below)
    worker.py     loads the model, answers JSON requests on stdin/stdout (see engines/base.py)
    .venv/        its own Python packages, so engines can never break each other

Only one engine is kept in memory at a time (small GPU)."""
import json
import os
import subprocess
import threading
from pathlib import Path

from .config import MODELS, ROOT, TMP

ENGINES = ROOT / "engines"
_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# emotion: the engine can really change how animated the voice is (not just pace). style: it understands a style prompt.
FIELDS = {"name": "", "licence": "", "commercial": False, "note": "", "style": False, "emotion": False,
          "max_chars": 260, "merge_under": 0, "order": 99,
          "match": 3, "speed": 3, "rtf": 2.0}  # match/speed: 1-5 for the picker; rtf: seconds to make 1 s of audio


def installed() -> list[dict]:
    """Engines that are fully installed (have engine.json, worker.py and a venv), best first."""
    out = []
    for f in ENGINES.glob("*/engine.json"):
        d = f.parent
        if (d / "worker.py").exists() and (d / ".venv/Scripts/python.exe").exists():
            out.append({**FIELDS, **json.loads(f.read_text(encoding="utf-8")), "id": d.name})
    return sorted(out, key=lambda e: e["order"])


def get(engine_id: str) -> dict:
    all_ = installed()
    if not all_:
        raise RuntimeError("No voice engine is installed yet.")
    return next((e for e in all_ if e["id"] == engine_id), all_[0])


class _Worker:
    def __init__(self, engine_id: str):
        d = ENGINES / engine_id
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONPATH": str(ENGINES),
               "HF_HOME": str(MODELS / "hf"), "TORCH_HOME": str(MODELS / "torch"), "TEMP": str(TMP), "TMP": str(TMP)}
        self.id = engine_id
        self.log = open(d / "worker.log", "w", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen([str(d / ".venv/Scripts/python.exe"), "-u", str(d / "worker.py")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, cwd=str(d),
                                     env=env, text=True, encoding="utf-8", errors="replace", creationflags=_NOWIN)
        self.info = self._read()
        if not self.info.get("ready"):
            self.stop()
            raise RuntimeError(self.info.get("error") or "The voice model could not be loaded.")

    def _read(self) -> dict:
        line = self.proc.stdout.readline()
        if not line:
            tail = (ENGINES / self.id / "worker.log").read_text(encoding="utf-8", errors="replace").strip().splitlines()[-1:]
            return {"ok": False, "ready": False, "error": "The voice engine stopped unexpectedly. " + " ".join(tail)}
        return json.loads(line)

    def call(self, req: dict) -> dict:
        try:
            self.proc.stdin.write(json.dumps(req) + "\n")
            self.proc.stdin.flush()
        except OSError:
            return {"ok": False, "error": "The voice engine stopped unexpectedly."}
        return self._read()

    def alive(self) -> bool:
        return self.proc.poll() is None

    def stop(self) -> None:
        try:
            self.proc.kill()
        except OSError:
            pass
        self.log.close()


_lock = threading.Lock()
_worker: _Worker | None = None
loading: str | None = None  # shown in the UI header while a model loads


def ensure(engine_id: str) -> _Worker:
    """Return the running worker for this engine, (re)starting it and stopping any other engine."""
    global _worker, loading
    with _lock:
        if _worker and _worker.id == engine_id and _worker.alive():
            return _worker
        if _worker:
            _worker.stop()
            _worker = None
        loading = f"Loading {get(engine_id)['name']}…"
        try:
            _worker = _Worker(engine_id)
        finally:
            loading = None
        return _worker


def device() -> str:
    return (_worker.info.get("device") if _worker and _worker.alive() else None) or "idle"


def shutdown() -> None:
    if _worker:
        _worker.stop()
