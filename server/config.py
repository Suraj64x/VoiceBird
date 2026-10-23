"""Paths and environment. Imported first so every model and cache stays inside the app folder."""
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOICES = ROOT / "voices"
PROJECTS = ROOT / "projects"
MODELS = ROOT / "models"
TMP = ROOT / ".cache" / "tmp"
for d in (VOICES, PROJECTS, MODELS, TMP):
    d.mkdir(parents=True, exist_ok=True)

os.environ.setdefault("HF_HOME", str(MODELS / "hf"))
os.environ.setdefault("TORCH_HOME", str(MODELS / "torch"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ["TEMP"] = os.environ["TMP"] = str(TMP)


def _find(env: str, name: str, *guesses: str, required: bool = True) -> str:
    for c in (os.environ.get(env), shutil.which(name), *guesses):
        if c and Path(c).exists():
            return str(c)
    if required:
        raise RuntimeError(f"{name} not found. Run 'Repair VoiceBird', or set {env} to its full path.")
    return ""


# Installed copies live in runtime/ (the installer puts them there); a dev setup can use PATH or the guesses.
RUNTIME = ROOT / "runtime"
_WINGET = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
FFMPEG = _find("VOICECLONER_FFMPEG", "ffmpeg", str(RUNTIME / "ffmpeg/ffmpeg.exe"),
               *map(str, _WINGET.glob("Gyan.FFmpeg*/ffmpeg-*/bin/ffmpeg.exe")))
# Whisper (transcripts, subtitles) is optional at start: the app still runs and says what is missing when it is needed.
_WHISPER_DIR = ROOT.parent / "whisper.cpp"
WHISPER = _find("VOICECLONER_WHISPER", "whisper-cli", str(RUNTIME / "whisper/whisper-cli.exe"),
                str(_WHISPER_DIR / "build/bin/whisper-cli.exe"), required=False)
WHISPER_MODEL = _find("VOICECLONER_WHISPER_MODEL", "ggml-medium.en.bin",
                      *(str(d / f"ggml-{m}.en.bin") for m in ("medium", "small", "base") for d in (RUNTIME / "whisper", _WHISPER_DIR)),
                      required=False)
