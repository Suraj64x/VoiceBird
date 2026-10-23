"""VoiceBird backend. Started by the UI dev server (ui/vite.config.ts), or by hand:
    .venv/Scripts/python -m uvicorn server.app:app --port 7879
Everything is stored as plain files: voices/<id>/, projects/<id>/ (project.json, takes/, exports/)."""
from . import config  # noqa: F401  (first: points every cache at D:)

import json
import os
import random
import re

import numpy as np
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from . import audio, engines, text
from .config import PROJECTS, ROOT, TMP, VOICES

LOCK = threading.RLock()
ID = re.compile(r"^[a-f0-9]{8,32}$")
FILE = re.compile(r"^[\w][\w.\- ]{0,120}$")
JOB: dict | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    def warm():  # load the default engine in the background so the first Generate is quick
        try:
            if engines.installed():
                engines.ensure(engines.get("")["id"])
        except Exception as e:  # noqa: BLE001
            print("warm-up failed:", e)
    for f in TMP.glob("*.wav"):  # our own leftovers from a crash or an interrupted export
        try:
            f.unlink()
        except OSError:
            pass
    threading.Thread(target=warm, daemon=True).start()
    yield
    engines.shutdown()


app = FastAPI(title="VoiceBird", lifespan=lifespan)
_LOCAL = r"(localhost|127\.0\.0\.1|\[::1\])(:\d+)?"


@app.middleware("http")
async def local_only(request: Request, call_next):
    """Only this PC's own browser may use the app (blocks other web pages and DNS-rebinding tricks)."""
    origin = request.headers.get("origin", "")
    if not re.fullmatch(_LOCAL, request.headers.get("host", "")) or (origin and not re.fullmatch(rf"https?://{_LOCAL}", origin)):
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    return await call_next(request)


def _id() -> str:
    return uuid.uuid4().hex[:12]


def _ok(*ids: str) -> None:
    if not all(ID.match(i) for i in ids):
        raise HTTPException(404, "Not found")


def _load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def _save(p: Path, data: dict) -> None:
    t = p.with_suffix(".tmp")
    t.write_text(json.dumps(data, indent=1), encoding="utf-8")
    for _ in range(40):  # atomic swap; Windows refuses it while another request is reading the file
        try:
            return t.replace(p)
        except PermissionError:
            time.sleep(0.05)
    t.replace(p)


# ====================== pictures (voices + folders) ======================
def _picture(file: UploadFile) -> bytes:
    """A small cropped picture from the UI (WebP, PNG or JPEG, 2 MB max)."""
    data = file.file.read(2_000_001)
    if len(data) > 2_000_000:
        raise HTTPException(400, "That picture is too big (2 MB max).")
    if not ((data[:4] == b"RIFF" and data[8:12] == b"WEBP") or data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"\xff\xd8\xff"):
        raise HTTPException(400, "That file is not a picture.")
    return data


def _serve_picture(path: Path) -> Response:
    if not path.exists():
        raise HTTPException(404, "No picture.")
    data = path.read_bytes()
    kind = "image/webp" if data[:4] == b"RIFF" else "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
    return Response(data, media_type=kind, headers={"Cache-Control": "max-age=31536000, immutable"})  # URL carries ?v=


# ====================== voices ======================
def _voices() -> list[dict]:
    return sorted((_load(f) for f in VOICES.glob("*/voice.json")), key=lambda v: v["created"])


def _voice(vid: str) -> dict:
    _ok(vid)
    f = VOICES / vid / "voice.json"
    if not f.exists():
        raise HTTPException(404, "That voice no longer exists.")
    return _load(f)


class VoicePatch(BaseModel):
    name: str | None = None
    default: bool | None = None
    transcript: str | None = None


@app.get("/api/voices")
def list_voices():
    return _voices()


@app.post("/api/voices")
def add_voice(file: UploadFile = File(...), name: str = Form(...), start: float = Form(0), end: float = Form(0),
              clean: bool = Form(True), transcript: str = Form(""), consent: bool = Form(False)):
    if not consent:
        raise HTTPException(400, "Please confirm you own this voice or have permission to use it.")
    name = name.strip()[:60]
    if not name:
        raise HTTPException(400, "Give the voice a name.")
    vid = _id()
    d = VOICES / vid
    d.mkdir(parents=True)
    try:
        ext = Path(file.filename or "").suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,5}", ext):
            ext = ".bin"
        src = d / f"source{ext}"
        with src.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        duration, cropped = audio.make_reference(src, d / "ref.wav", max(0.0, start), end, clean)
        # a typed transcript only fits when the whole selection was kept
        transcript = (transcript.strip() if not cropped else "") or " ".join(s["text"] for s in audio.transcribe(d / "ref.wav"))
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, str(e) if isinstance(e, ValueError) else "That file could not be read as audio.") from e
    with LOCK:
        v = {"id": vid, "name": name, "default": not _voices(), "transcript": transcript,
             "duration": round(duration, 2), "created": time.time(), "consent": True}
        _save(d / "voice.json", v)
    return v


@app.patch("/api/voices/{vid}")
def patch_voice(vid: str, body: VoicePatch):
    with LOCK:
        v = _voice(vid)
        if body.name is not None and body.name.strip():
            v["name"] = body.name.strip()[:60]
        if body.transcript is not None:
            v["transcript"] = body.transcript.strip()
        if body.default:
            for o in _voices():
                if o["default"] and o["id"] != vid:
                    _save(VOICES / o["id"] / "voice.json", {**o, "default": False})
            v["default"] = True
        _save(VOICES / vid / "voice.json", v)
    return v


@app.delete("/api/voices/{vid}")
def delete_voice(vid: str):
    if JOB and JOB["running"] and JOB.get("voice") == vid:
        raise HTTPException(409, "This voice is speaking right now. Stop it first.")
    with LOCK:
        v = _voice(vid)
        shutil.rmtree(VOICES / vid, ignore_errors=True)
        rest = _voices()
        if v["default"] and rest:  # always keep a default
            _save(VOICES / rest[0]["id"] / "voice.json", {**rest[0], "default": True})
    return {"ok": True}


MOODS = ("neutral", "friendly", "excited", "calm", "soft", "serious", "sad", "angry", "whisper")


def _mood(mood: str) -> str:
    if mood not in MOODS:
        raise HTTPException(404, "Unknown mood.")
    return mood


@app.post("/api/voices/{vid}/moods/{mood}")
def add_mood(vid: str, mood: str, file: UploadFile = File(...), start: float = Form(0), end: float = Form(0),
             clean: bool = Form(True), transcript: str = Form(""), consent: bool = Form(False)):
    """A second sample of the same voice in one mood. Engines copy the delivery of their reference,
    so picking that emotion then really changes how it sounds."""
    _mood(mood)
    if not consent:
        raise HTTPException(400, "Please confirm you own this voice or have permission to use it.")
    _voice(vid)
    d = VOICES / vid / "moods"
    d.mkdir(exist_ok=True)
    ext = Path(file.filename or "").suffix.lower()
    src = d / f"{mood}.source{ext if re.fullmatch(r'[.][a-z0-9]{1,5}', ext) else '.bin'}"
    part = d / f"{mood}.part.wav"
    try:
        with src.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        duration, cropped = audio.make_reference(src, part, max(0.0, start), end, clean)
        transcript = (transcript.strip() if not cropped else "") or " ".join(x["text"] for x in audio.transcribe(part))
        part.replace(d / f"{mood}.wav")
    except Exception as e:  # noqa: BLE001
        part.unlink(missing_ok=True)
        raise HTTPException(400, str(e) if isinstance(e, ValueError) else "That file could not be read as audio.") from e
    finally:
        src.unlink(missing_ok=True)
    with LOCK:
        v = _voice(vid)
        v.setdefault("moods", {})[mood] = {"transcript": transcript, "duration": round(duration, 2), "created": time.time()}
        _save(VOICES / vid / "voice.json", v)
    return v


@app.delete("/api/voices/{vid}/moods/{mood}")
def delete_mood(vid: str, mood: str):
    _mood(mood)
    with LOCK:
        v = _voice(vid)
        v.get("moods", {}).pop(mood, None)
        _save(VOICES / vid / "voice.json", v)
        (VOICES / vid / "moods" / f"{mood}.wav").unlink(missing_ok=True)
    return v


@app.get("/api/voices/{vid}/moods/{mood}/audio")
def mood_audio(vid: str, mood: str):
    _mood(mood)
    _voice(vid)
    f = VOICES / vid / "moods" / f"{mood}.wav"
    if not f.exists():
        raise HTTPException(404, "No sample for that mood.")
    return FileResponse(f, media_type="audio/wav")


@app.get("/api/voices/{vid}/audio")
def voice_audio(vid: str):
    _voice(vid)
    return FileResponse(VOICES / vid / "ref.wav", media_type="audio/wav")


@app.post("/api/voices/{vid}/image")
def set_voice_image(vid: str, file: UploadFile = File(...)):
    data = _picture(file)
    with LOCK:
        v = _voice(vid)
        (VOICES / vid / "image.img").write_bytes(data)
        v["image"] = int(time.time() * 1000)
        _save(VOICES / vid / "voice.json", v)
    return v


@app.delete("/api/voices/{vid}/image")
def drop_voice_image(vid: str):
    with LOCK:
        v = _voice(vid)
        (VOICES / vid / "image.img").unlink(missing_ok=True)
        v["image"] = 0
        _save(VOICES / vid / "voice.json", v)
    return v


@app.get("/api/voices/{vid}/image")
def voice_image(vid: str):
    _ok(vid)
    return _serve_picture(VOICES / vid / "image.img")


# ====================== folders (groups of projects) ======================
FOLDERS = PROJECTS / "_folders"
FOLDERS.mkdir(exist_ok=True)
FOLDERS_FILE = FOLDERS / "folders.json"


class FolderBody(BaseModel):
    name: str = "New folder"


def _folders() -> list[dict]:
    return _load(FOLDERS_FILE) if FOLDERS_FILE.exists() else []


def _folder(fid: str, folders: list[dict]) -> dict:
    _ok(fid)
    f = next((x for x in folders if x["id"] == fid), None)
    if not f:
        raise HTTPException(404, "That folder no longer exists.")
    return f


def _drop_folders(ids: set[str], delete_projects: bool) -> None:
    """Remove folders. Their projects move out to the top level, or are deleted too
    (except a project that is generating right now, which is moved out instead)."""
    busy = JOB["project"] if JOB and JOB["running"] else None
    for pf in PROJECTS.glob("*/project.json"):
        p = _load(pf)
        if p.get("folder") in ids:
            if delete_projects and p["id"] != busy:
                shutil.rmtree(pf.parent, ignore_errors=True)
            else:
                _save(pf, {**p, "folder": None})
    for i in ids:
        (FOLDERS / f"{i}.img").unlink(missing_ok=True)
    _save(FOLDERS_FILE, [f for f in _folders() if f["id"] not in ids])


@app.get("/api/folders")
def list_folders():
    return _folders()


@app.post("/api/folders")
def new_folder(body: FolderBody):
    with LOCK:
        f = {"id": _id(), "name": body.name.strip()[:60] or "New folder", "created": time.time(), "image": 0}
        _save(FOLDERS_FILE, [*_folders(), f])
    return f


@app.patch("/api/folders/{fid}")
def rename_folder(fid: str, body: FolderBody):
    with LOCK:
        fs = _folders()
        f = _folder(fid, fs)
        f["name"] = body.name.strip()[:60] or f["name"]
        _save(FOLDERS_FILE, fs)
    return f


@app.delete("/api/folders/{fid}")
def delete_folder(fid: str, projects: str = "keep"):
    with LOCK:
        _folder(fid, _folders())
        _drop_folders({fid}, projects == "delete")
    return {"ok": True}


@app.delete("/api/folders")
def delete_all_folders(projects: str = "keep"):
    with LOCK:
        _drop_folders({f["id"] for f in _folders()}, projects == "delete")
    return {"ok": True}


@app.post("/api/folders/{fid}/image")
def set_folder_image(fid: str, file: UploadFile = File(...)):
    data = _picture(file)
    with LOCK:
        fs = _folders()
        f = _folder(fid, fs)
        (FOLDERS / f"{fid}.img").write_bytes(data)
        f["image"] = int(time.time() * 1000)
        _save(FOLDERS_FILE, fs)
    return f


@app.delete("/api/folders/{fid}/image")
def drop_folder_image(fid: str):
    with LOCK:
        fs = _folders()
        f = _folder(fid, fs)
        (FOLDERS / f"{fid}.img").unlink(missing_ok=True)
        f["image"] = 0
        _save(FOLDERS_FILE, fs)
    return f


@app.get("/api/folders/{fid}/image")
def folder_image(fid: str):
    _ok(fid)
    return _serve_picture(FOLDERS / f"{fid}.img")


# ====================== projects ======================
def _pfile(pid: str) -> Path:
    _ok(pid)
    f = PROJECTS / pid / "project.json"
    if not f.exists():
        raise HTTPException(404, "That project no longer exists.")
    return f


class ProjectBody(BaseModel):
    name: str = "Untitled script"
    script: str = ""
    settings: dict = {}
    folder: str | None = None  # only used when creating


class ProjectPatch(BaseModel):
    name: str | None = None
    folder: str | None = None  # null = move out of any folder (only applied when sent)


class Pick(BaseModel):
    key: str
    take: str


@app.get("/api/projects")
def list_projects():
    ps = [_load(f) for f in PROJECTS.glob("*/project.json")]
    return [{"id": p["id"], "name": p["name"], "updated": p["updated"], "words": len(p["script"].split()),
             "folder": p.get("folder")} for p in sorted(ps, key=lambda p: -p["updated"])]


@app.post("/api/projects")
def new_project(body: ProjectBody):
    if body.folder:
        _folder(body.folder, _folders())
    pid = _id()
    (PROJECTS / pid / "takes").mkdir(parents=True)
    p = {"id": pid, "name": body.name[:120], "script": body.script, "settings": body.settings,
         "takes": {}, "picked": {}, "updated": time.time(), "folder": body.folder}
    _save(PROJECTS / pid / "project.json", p)
    return p


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _load(_pfile(pid))


@app.put("/api/projects/{pid}")
def put_project(pid: str, body: ProjectBody):
    with LOCK:
        f = _pfile(pid)
        p = {**_load(f), "name": body.name[:120], "script": body.script, "settings": body.settings, "updated": time.time()}
        _save(f, p)
    return {"ok": True}


@app.patch("/api/projects/{pid}")
def patch_project(pid: str, body: ProjectPatch):
    """Rename and/or move to a folder, without touching the script."""
    with LOCK:
        f = _pfile(pid)
        p = _load(f)
        if body.name is not None and body.name.strip():
            p["name"] = body.name.strip()[:120]
        if "folder" in body.model_fields_set:
            if body.folder:
                _folder(body.folder, _folders())
            p["folder"] = body.folder or None
        _save(f, p)
    return {"ok": True}


@app.post("/api/projects/{pid}/duplicate")
def duplicate_project(pid: str):
    """A copy with the same script, settings and takes (exports are not copied)."""
    with LOCK:
        p = _load(_pfile(pid))
        nid = _id()
        try:
            shutil.copytree(PROJECTS / pid, PROJECTS / nid, ignore=shutil.ignore_patterns("exports", "*.tmp", "preview.wav"))
            p.update(id=nid, name=f"{p['name']} copy"[:120], updated=time.time())
            _save(PROJECTS / nid / "project.json", p)
        except Exception as e:  # never leave a half copy that still carries the original's id
            shutil.rmtree(PROJECTS / nid, ignore_errors=True)
            raise HTTPException(500, "Could not duplicate that project.") from e
    return p


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    if JOB and JOB["running"] and JOB["project"] == pid:
        raise HTTPException(409, "This project is generating right now. Stop it first.")
    with LOCK:
        _pfile(pid)
        shutil.rmtree(PROJECTS / pid, ignore_errors=True)
    return {"ok": True}


@app.post("/api/projects/{pid}/pick")
def pick_take(pid: str, body: Pick):
    with LOCK:
        f = _pfile(pid)
        p = _load(f)
        if not any(t["id"] == body.take for t in p["takes"].get(body.key, [])):
            raise HTTPException(404, "That take no longer exists.")
        p["picked"][body.key] = body.take
        _save(f, p)
    return {"ok": True}


@app.delete("/api/projects/{pid}/takes/{tid}")
def delete_take(pid: str, tid: str):
    _ok(tid)
    with LOCK:
        f = _pfile(pid)
        p = _load(f)
        for key, takes in list(p["takes"].items()):
            keep = [t for t in takes if t["id"] != tid]
            if len(keep) != len(takes):
                p["takes"][key] = keep
                if p["picked"].get(key) == tid:
                    p["picked"].pop(key)
                    if keep:
                        p["picked"][key] = keep[-1]["id"]
                if not keep:
                    p["takes"].pop(key)
        _save(f, p)
        for f in (PROJECTS / pid / "takes").glob(f"{tid}*.wav"):  # the take and its toned copies
            f.unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/projects/{pid}/takes/{name}")
def take_audio(pid: str, name: str, tone: str = ""):
    tid = name.removesuffix(".wav")
    _ok(pid, tid)
    f = PROJECTS / pid / "takes" / f"{tid}.wav"
    if not f.exists():
        raise HTTPException(404, "That take no longer exists.")
    return FileResponse(audio.toned(f, tone), media_type="audio/wav")


# ====================== pronunciation ("say it like this") ======================
WORDS = ROOT / "words.json"


class Word(BaseModel):
    said: str
    say: str


def _words() -> list[dict]:
    return _load(WORDS) if WORDS.exists() else []


@app.get("/api/words")
def list_words():
    return _words()


PRESET_FILE = ROOT / "presets.json"


class Preset(BaseModel):
    """A saved delivery style: everything about how it is said, not which voice or engine."""
    name: str
    emotion: str = "friendly"
    intensity: float = 50
    style: str = ""
    speed: float = 1.0
    pitch: float = 0.0
    pause: float = 0.6
    variation: float = 50
    tone: str = "natural"


@app.get("/api/presets")
def list_presets():
    return _load(PRESET_FILE) if PRESET_FILE.exists() else []


@app.put("/api/presets")
def put_presets(body: list[Preset]):
    clean = [{**x.model_dump(), "name": x.name.strip()[:40]} for x in body[:60] if x.name.strip()]
    with LOCK:
        _save(PRESET_FILE, clean)
    return clean


@app.get("/api/history")
def history(limit: int = 40):
    """Newest takes across every project."""
    out = []
    for f in PROJECTS.glob("*/project.json"):
        try:
            pr = _load(f)
        except (OSError, ValueError):
            continue
        for key, ts in pr["takes"].items():
            for t in ts:
                out.append({"project": pr["id"], "projectName": pr["name"], "key": key, "id": t["id"],
                            "text": t.get("text", "")[:160], "engine": t.get("engine", ""), "voiceName": t.get("voiceName", ""),
                            "label": t.get("label", ""), "duration": t.get("duration", 0), "created": t.get("created", 0),
                            "picked": pr["picked"].get(key) == t["id"]})
    out.sort(key=lambda t: -t["created"])
    return out[:max(1, min(200, limit))]


@app.put("/api/words")
def put_words(body: list[Word]):
    clean = [{"said": w.said.strip()[:60], "say": w.say.strip()[:120]} for w in body[:300] if w.said.strip() and w.say.strip()]
    with LOCK:
        _save(WORDS, clean)
    return clean


def say_as(line: str, words: list[dict]) -> str:
    """Swap whole words for how they should be spoken (longest first, any letter case)."""
    for w in sorted(words, key=lambda w: -len(w["said"])):
        line = re.sub(rf"(?<!\w){re.escape(w['said'])}(?!\w)", lambda _m, to=w["say"]: to, line, flags=re.I)
    return line


# ====================== delivery (emotion presets + style prompt) ======================
# energy: how animated (0 flat .. 1 very lively). speed: gentle pace nudge. Engines map energy to their own knobs.
PRESETS = {
    "neutral": (0.35, 1.00), "friendly": (0.50, 1.00), "excited": (0.80, 1.05), "calm": (0.20, 0.95),
    "serious": (0.30, 0.97), "sad": (0.15, 0.92), "angry": (0.90, 1.03), "whisper": (0.10, 0.95), "soft": (0.15, 0.96),
}
# style-prompt words -> (energy change, speed factor, pitch change in semitones); used by every engine,
# and engines that understand instructions also get the prompt text itself.
HINTS = [
    (r"\b(hyped?|excited|energetic|enthusiastic|upbeat|lively|punchy|pumped)\b", (+0.20, 1.00, 0)),
    (r"\b(smil\w*|cheerful|happy|warm|friendly|bright)\b", (+0.08, 1.00, 0)),
    (r"\b(calm|soft|gentle|sooth\w*|quiet|mellow|relaxed|chill)\b", (-0.20, 1.00, 0)),
    (r"\b(serious|formal|documentary|news)\b", (-0.10, 1.00, 0)),
    (r"\b(fast|quick\w*|rapid|snappy)\b", (0, 1.06, 0)),
    (r"\b(slow\w*|unhurried|measured)\b", (0, 0.93, 0)),
    (r"\b(deep|deeper|low(er)? voice|bassy)\b", (0, 1.00, -1.0)),
    (r"\b(high(er)? voice|higher pitch)\b", (0, 1.00, +1.0)),
]


def delivery(s: dict) -> dict:
    """UI settings -> what the engine and the post-processing actually do."""
    emotion = s.get("emotion") if s.get("emotion") in PRESETS else "friendly"
    k = float(s.get("intensity", 50)) / 50  # 50% = the preset as designed, 0% = neutral, 100% = doubled
    n_energy, _ = PRESETS["neutral"]
    p_energy, p_speed = PRESETS[emotion]
    energy = n_energy + (p_energy - n_energy) * k
    speed = float(s.get("speed", 1)) * (1 + (p_speed - 1) * k)
    pitch = float(s.get("pitch", 0))
    style = str(s.get("style") or "").strip()
    for rx, (de, fs, dp) in HINTS:
        if re.search(rx, style, re.I):
            energy, speed, pitch = energy + de, speed * fs, pitch + dp
    if re.search(r"\bwhisper", style, re.I):
        emotion = "whisper"
    return {"emotion": emotion, "energy": min(1.0, max(0.0, energy)), "style": style,
            "variation": min(1.0, max(0.0, float(s.get("variation", 50)) / 100)),
            "speed": min(1.5, max(0.6, speed)), "pitch": min(8.0, max(-8.0, pitch))}


# ====================== generation queue (one job at a time) ======================
class Item(BaseModel):
    key: str
    text: str


class GenReq(BaseModel):
    items: list[Item]
    settings: dict = {}


def _public(job: dict | None) -> dict | None:
    return job and {k: v for k, v in job.items() if k != "cancel"}


@app.get("/api/status")
def status():
    es = engines.installed()
    return {"device": engines.device(), "loading": engines.loading, "job": _public(JOB),
            "engines": [{k: e[k] for k in ("id", "name", "licence", "commercial", "note", "style", "emotion", "match", "speed", "rtf")} for e in es],
            "defaultEngine": es[0]["id"] if es else ""}


@app.post("/api/quit")
def quit_app():
    """Stop VoiceBird (it runs without a window when started from the shortcut)."""
    def bye():
        engines.shutdown()
        os._exit(0)
    threading.Timer(0.4, bye).start()
    return {"ok": True}


@app.post("/api/job/cancel")
def cancel():
    if JOB and JOB["running"]:
        JOB["cancel"] = True
        JOB["message"] = "Stopping…"
        engines.shutdown()  # stop right now; the engine reloads on the next Generate
    return {"ok": True}


@app.post("/api/projects/{pid}/generate")
def generate(pid: str, req: GenReq):
    global JOB
    items = [i for i in req.items if i.text.strip()]
    if not items:
        raise HTTPException(400, "Write something first.")
    with LOCK:
        if JOB and JOB["running"]:
            raise HTTPException(409, "Already generating. Stop it or wait for it to finish.")
        _pfile(pid)
        vs = _voices()
        voice = next((v for v in vs if v["id"] == req.settings.get("voice")), None) or next((v for v in vs if v["default"]), None)
        if not voice:
            raise HTTPException(400, "Add a voice first.")
        try:
            engine = engines.get(str(req.settings.get("engine") or ""))
        except RuntimeError as e:
            raise HTTPException(503, str(e)) from e
        JOB = {"id": _id(), "project": pid, "running": True, "cancel": False, "total": len(items), "done": 0,
               "items": [{"key": i.key, "state": "queued"} for i in items], "message": "Getting ready…", "voice": voice["id"],
               "error": None, "eta": None}
    threading.Thread(target=_run, args=(JOB, pid, items, req.settings, voice, engine), daemon=True).start()
    return _public(JOB)


def _plausible(seconds: float, chars: int) -> bool:
    """Catches the two classic failures: cut off early, or rambling on. Normal speech is ~12-20 chars/s."""
    return chars / 32 <= seconds <= chars / 5 + 2.5


def _rate(words: str, x, sr: int) -> float:
    """Words per second of talking (long pauses left out). 0 when there is too little to judge."""
    n, t = len(re.findall(r"[\w']+", words)), audio.talk_seconds(x, sr)
    return n / t if n >= 6 and t >= 2 else 0.0


def _speak(worker, req: dict, chars: int):
    """One chunk -> trimmed, level-matched, faded audio. One retry with another seed if the length looks wrong."""
    best = None
    for attempt in range(2):
        out = audio.tmp()
        try:
            res = worker.call({**req, "seed": req["seed"] + attempt * 7919, "out": str(out)})
            if not res.get("ok"):
                raise RuntimeError(res.get("error") or "The voice engine failed.")
            x, sr = audio.read(out)
        finally:
            out.unlink(missing_ok=True)
        x = audio.trim_silence(x, sr)
        if best is None or _plausible(len(x) / sr, chars):
            best = (x, sr)
        if _plausible(len(x) / sr, chars):
            break
    x, sr = best
    return audio.fade(audio.match_level(x, sr), sr), sr


GAP = 0.10  # silence added between sentences (each chunk also keeps ~0.12 s of its own breathing room)


def _run(job: dict, pid: str, items: list[Item], settings: dict, voice: dict, engine: dict) -> None:
    try:
        d = delivery(settings)
        job["message"] = f"Loading {engine['name']}…"
        worker = engines.ensure(engine["id"])
        words = _words()
        # item -> paragraphs (blank lines; several only in "one take" mode) -> chunks (whole groups of sentences: natural flow, few joins)
        plan = [[text.chunks(q, engine["max_chars"], engine["max_chars"]) for q in re.split(r"\n\s*\n", say_as(i.text, words)) if q.strip()]
                for i in items]
        total = sum(len(c) for ps in plan for cs in ps for c in cs) or 1
        pause = min(5.0, max(0.0, float(settings.get("pause", 0.6))))
        spoken, t0 = 0, time.time()
        mood = (voice.get("moods") or {}).get(d["emotion"])  # a sample of this voice in this mood beats any knob
        ref = VOICES / voice["id"] / (f"moods/{d['emotion']}.wav" if mood else "ref.wav")
        ref_text = mood["transcript"] if mood else voice["transcript"]
        ref_rate = _rate(ref_text, *audio.read(ref))  # the sample's own pace
        base = {"ref": str(ref), "ref_text": ref_text,
                **{k: d[k] for k in ("emotion", "energy", "style", "variation")}}
        for n, (item, ps) in enumerate(zip(items, plan)):
            if job["cancel"]:
                break
            job["items"][n]["state"] = "running"
            seed = int(settings.get("seed", 0)) if settings.get("lockSeed", True) else random.randrange(1_000_000)
            if settings.get("lockSeed", True):  # same seed + same settings = same audio, so a retake steps the seed
                with LOCK:
                    f = PROJECTS / pid / "project.json"
                    same = [t["seed"] for t in (_load(f)["takes"].get(item.key, []) if f.exists() else []) if t.get("settings") == settings]
                if same:
                    seed = max(seed, max(same) + 1000)
            parts, gaps, sr = [], [], 24000
            cs = [c for q in ps for c in q]
            starts = {sum(len(q) for q in ps[:k]) for k in range(1, len(ps))}  # first chunk of each later paragraph
            for c_i, chunk in enumerate(cs):
                if job["cancel"]:
                    break
                job["message"] = f"Paragraph {n + 1} of {len(items)} · part {c_i + 1} of {len(cs)}"
                x, sr = _speak(worker, {**base, "text": chunk, "seed": seed + c_i}, len(chunk))
                if parts:
                    gaps.append(pause if c_i in starts else GAP)
                parts.append(x)
                spoken += len(chunk)
                job["eta"] = round((time.time() - t0) / spoken * (total - spoken))
            if job["cancel"]:
                job["items"][n]["state"] = "queued"
                break
            if not parts:  # nothing speakable in this paragraph: skip it, keep going
                job["items"][n]["state"] = "error"
                continue
            tid = _id()
            dst = PROJECTS / pid / "takes" / f"{tid}.wav"
            y = np.concatenate([b for k, x in enumerate(parts) for b in ((np.zeros(int(sr * gaps[k - 1]), np.float32),) if k else ()) + (x.astype(np.float32),)])
            ends = [sum(len(q) for q in parts[:k + 1]) / sr + sum(gaps[:k]) + gaps[k] / 2 for k in range(len(parts) - 1)]
            out_rate = _rate(" ".join(cs), y, sr)
            speed = d["speed"] * (min(1.2, max(0.85, ref_rate / out_rate)) if ref_rate and out_rate else 1.0)
            if abs(speed - 1) < 0.03 and abs(d["speed"] - 1) <= 0.005:
                speed = 1.0  # close enough to the sample's pace: leave the audio untouched
            if abs(speed - 1) > 0.005 or abs(d["pitch"]) > 0.01:
                raw = audio.tmp()
                try:
                    audio.write(raw, y, sr)
                    audio.stretch(raw, dst, speed, d["pitch"])
                finally:
                    raw.unlink(missing_ok=True)
                y, sr = audio.read(dst)
                y = audio.match_level(y, sr)  # stretching changes the level; bring it back
                audio.write(dst, y, sr)
                ends = [e / speed for e in ends]
            else:
                audio.write(dst, y, sr)
            label = f"{d['emotion'].title()} {int(settings.get('intensity', 50))}%" + (" · mood sample" if mood else "")
            label += f" · {d['speed']:.2f}×" if abs(d["speed"] - 1) > 0.005 else ""
            label += f" · {d['pitch']:+g} st" if abs(d["pitch"]) > 0.01 else ""
            take = {"id": tid, "key": item.key, "engine": engine["name"], "voiceName": voice["name"], "seed": seed,
                    "duration": round(len(y) / sr, 2), "created": time.time(), "label": label,
                    "text": item.text, "joins": [round(e, 3) for e in ends], "settings": settings,
                    "peaks": audio.peaks(y)}
            with LOCK:
                f = PROJECTS / pid / "project.json"
                if not f.exists():  # project deleted meanwhile
                    dst.unlink(missing_ok=True)
                    break
                p = _load(f)
                p["takes"].setdefault(item.key, []).append(take)
                p["picked"][item.key] = tid
                p["updated"] = time.time()
                _save(f, p)
            job["items"][n]["state"] = "done"
            job["done"] += 1
        job["message"] = "Stopped" if job["cancel"] else "Done"
    except Exception as e:  # noqa: BLE001
        if job["cancel"]:  # Stop kills the engine mid-sentence; that is not an error
            job["message"] = "Stopped"
        else:
            job["error"] = str(e)
            job["message"] = "Something went wrong"
    finally:
        job["eta"] = None
        job["running"] = False


# ====================== export ======================
class ExportReq(BaseModel):
    keys: list[str]
    wav: bool = True
    mp3: bool = True
    combined: bool = True
    paragraphs: bool = False
    master: bool = True
    srt: bool = False
    pause: float = 0.6
    tone: str = ""


SR_OUT = 48000


def _picked_takes(p: dict, keys: list[str]) -> list[dict]:
    takes = []
    for n, key in enumerate(keys, 1):
        t = next((t for t in p["takes"].get(key, []) if t["id"] == p["picked"].get(key)), None)
        if not t:
            raise HTTPException(400, f"Paragraph {n} has no take yet. Generate it first.")
        takes.append(t)
    if not takes:
        raise HTTPException(400, "There is nothing to export yet.")
    return takes


def _take_audio(pid: str, takes: list[dict], tone: str = "") -> list:
    """Takes may come from different engines (different sample rates): load all at 48 kHz, with the chosen tone."""
    return [audio.load_at(audio.toned(PROJECTS / pid / "takes" / f"{t['id']}.wav", tone), SR_OUT) for t in takes]


@app.get("/api/projects/{pid}/preview.wav")
def preview(pid: str, keys: str = "", pause: float = 0.6, tone: str = ""):
    """The whole script as it would export (picked takes + pauses, no mastering), for a quick listen."""
    p = _load(_pfile(pid))
    parts = _take_audio(pid, _picked_takes(p, [k for k in keys.split(",") if k]), tone)
    out = PROJECTS / pid / "preview.wav"
    audio.write(out, audio.join(parts, SR_OUT, min(5.0, max(0.0, pause))), SR_OUT)
    return FileResponse(out, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@app.post("/api/projects/{pid}/export")
def export(pid: str, req: ExportReq):
    p = _load(_pfile(pid))
    if not (req.wav or req.mp3) or not (req.combined or req.paragraphs):
        raise HTTPException(400, "Pick at least one format and one kind of file.")
    takes = _picked_takes(p, req.keys)
    pause = min(5.0, max(0.0, req.pause))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = PROJECTS / pid / "exports" / stamp
    n = 1
    while out.exists():  # two exports in the same second
        n += 1
        out = PROJECTS / pid / "exports" / f"{stamp}-{n}"
    out.mkdir(parents=True)
    slug = re.sub(r"[^\w\- ]+", "", p["name"]).strip().replace(" ", "-").strip("-")[:60] or "voice-over"
    files: list[dict] = []
    url = f"/api/projects/{pid}/exports/{out.name}/"

    def emit(x, name: str) -> Path:
        """Write one piece of audio as WAV and/or MP3 (mastered if asked). Returns the WAV (kept or temporary)."""
        wav = out / f"{name}.wav"
        note = ""
        if req.master:
            raw = audio.tmp()
            try:
                audio.write(raw, audio.cap_silences(x, SR_OUT, max(0.75, pause + 0.05)), SR_OUT)
                m = audio.master(raw, wav, sr=SR_OUT)
            finally:
                raw.unlink(missing_ok=True)
            note = f"{m['lufs']:.1f} LUFS · peak {m['true_peak']:.1f} dBTP"
        else:
            audio.write(wav, x, SR_OUT)
        if req.wav:
            files.append({"name": f"{name}.wav", "url": url + f"{name}.wav", "note": note})
        if req.mp3:
            audio.to_mp3(wav, out / f"{name}.mp3")
            files.append({"name": f"{name}.mp3", "url": url + f"{name}.mp3", "note": note})
        return wav

    parts = _take_audio(pid, takes, req.tone)
    suffix = "-master" if req.master else ""
    whole = audio.join(parts, SR_OUT, pause)
    keep: list[Path] = []
    if req.combined or req.srt:
        wav = emit(whole, slug + suffix) if req.combined else None
        if req.srt:
            src = wav
            if src is None:
                src = audio.tmp()
                audio.write(src, whole, SR_OUT)
            words = audio.transcribe(src, words=True)
            (out / f"{slug}.srt").write_text(audio.srt(words), encoding="utf-8")
            (out / f"{slug}.words.json").write_text(json.dumps(words, indent=1), encoding="utf-8")
            files += [{"name": f"{slug}.srt", "url": url + f"{slug}.srt", "note": "subtitles"},
                      {"name": f"{slug}.words.json", "url": url + f"{slug}.words.json", "note": "word timings"}]
            if wav is None:
                src.unlink(missing_ok=True)
        if wav is not None and not req.wav:
            keep.append(wav)
    if req.paragraphs:
        for n, x in enumerate(parts, 1):
            wav = emit(x, f"{slug}-p{n:02d}{suffix}")
            if not req.wav:
                keep.append(wav)
    for w in keep:  # WAVs that were only needed to make the MP3
        w.unlink(missing_ok=True)
    # where every join sits in the un-mastered combined audio (used by tests/quality.py)
    starts, t0 = [], 0.0
    for t, x in zip(takes, parts):
        starts.append(t0)
        t0 += len(x) / SR_OUT + pause
    _save(out / "manifest.json", {
        "project": p["name"], "pause": pause, "mastered": req.master,
        "paragraphs": [{"start": round(s, 3), "duration": round(len(x) / SR_OUT, 3), "text": t.get("text", ""),
                        "engine": t["engine"], "seed": t["seed"], "sentence_joins": [round(s + j, 3) for j in t.get("joins", [])]}
                       for s, t, x in zip(starts, takes, parts)],
        "paragraph_joins": [round(s - pause / 2, 3) for s in starts[1:]],
    })
    return {"files": files, "folder": str(out)}


@app.get("/api/projects/{pid}/exports/{stamp}/{name}")
def export_file(pid: str, stamp: str, name: str):
    _ok(pid)
    if not re.fullmatch(r"\d{8}-\d{6}(-\d+)?", stamp) or not FILE.match(name):
        raise HTTPException(404, "Not found")
    f = PROJECTS / pid / "exports" / stamp / name
    if not f.exists():
        raise HTTPException(404, "That file no longer exists.")
    return FileResponse(f, filename=name)


# ====================== the built screen (start.bat runs this on port 7878) ======================
_DIST = ROOT / "ui" / "dist"
if (_DIST / "index.html").exists():
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="ui")
