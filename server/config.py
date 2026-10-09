"""Paths and environment. Imported first so every cache lands on D: (C: is nearly full)."""
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


def _find(env: str, name: str, *guesses: str) -> str:
    for c in (os.environ.get(env), shutil.which(name), *guesses):
        if c and Path(c).exists():
            return str(c)
    raise RuntimeError(f"{name} not found. Set the {env} environment variable to its full path.")


_WINGET = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
FFMPEG = _find("VOICECLONER_FFMPEG", "ffmpeg", *map(str, _WINGET.glob("Gyan.FFmpeg*/ffmpeg-*/bin/ffmpeg.exe")))
# whisper.cpp already lives in this workspace (used by the video editor); reuse it.
_WHISPER_DIR = ROOT.parent / "whisper.cpp"
WHISPER = _find("VOICECLONER_WHISPER", "whisper-cli", str(_WHISPER_DIR / "build/bin/whisper-cli.exe"))
WHISPER_MODEL = _find("VOICECLONER_WHISPER_MODEL", "ggml-medium.en.bin", str(_WHISPER_DIR / "ggml-medium.en.bin"))
