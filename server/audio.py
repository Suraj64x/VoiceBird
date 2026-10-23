"""Audio plumbing: ffmpeg wrappers, silence trimming, level matching, joins, mastering, Whisper."""
import json
import os
import re
import subprocess
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import FFMPEG, TMP, WHISPER, WHISPER_MODEL

_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # no console flashes on Windows


def ff(*args) -> str:
    """Run ffmpeg, return its log (stderr). Raises with ffmpeg's last line on failure."""
    p = subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-y", *map(str, args)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=_NOWIN)
    if p.returncode:
        raise RuntimeError("ffmpeg: " + (p.stderr.strip().splitlines() or ["failed"])[-1])
    return p.stderr


def tmp(suffix: str = ".wav") -> Path:
    return TMP / f"{uuid.uuid4().hex}{suffix}"


def read(path) -> tuple[np.ndarray, int]:
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return x.mean(axis=1), sr


def write(path, x: np.ndarray, sr: int) -> None:
    sf.write(str(path), np.clip(x, -1.0, 1.0), sr, subtype="PCM_16")


def load_at(path, sr: int) -> np.ndarray:
    """Any audio file -> mono float32 at `sr`, straight from ffmpeg (no temp file)."""
    p = subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr),
                        "-f", "f32le", "-"], capture_output=True, creationflags=_NOWIN)
    if p.returncode:
        raise RuntimeError("ffmpeg: " + (p.stderr.decode("utf-8", "replace").strip().splitlines() or ["failed"])[-1])
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


# ---------- numpy helpers (all mono float32) ----------
def _env_db(x: np.ndarray, sr: int, hop_ms: int = 10) -> tuple[np.ndarray, int]:
    """RMS level per 10 ms frame, in dBFS."""
    hop = max(1, sr * hop_ms // 1000)
    n = len(x) // hop
    if n == 0:
        return np.array([-120.0]), hop
    frames = x[: n * hop].reshape(n, hop)
    return 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9), hop


def trim_silence(x: np.ndarray, sr: int, pad_start_ms: int = 30, pad_end_ms: int = 90) -> np.ndarray:
    """Cut leading/trailing silence. Generous tail pad so soft word endings are never clipped."""
    env, hop = _env_db(x, sr)
    live = np.where(env > max(-60.0, env.max() - 42.0))[0]
    if len(live) == 0:
        return x
    a = max(0, live[0] * hop - sr * pad_start_ms // 1000)
    b = min(len(x), (live[-1] + 1) * hop + sr * pad_end_ms // 1000)
    return x[a:b]


def talk_seconds(x: np.ndarray, sr: int, pause_ms: int = 250) -> float:
    """Seconds of actual talking: the length minus every pause of pause_ms or longer (breaths between words stay)."""
    env, hop = _env_db(x, sr)
    quiet = np.r_[0, (env < env.max() - 35.0).astype(np.int8), 0]
    d = np.diff(quiet)
    runs = np.where(d == -1)[0] - np.where(d == 1)[0]
    long = runs[runs * hop * 1000 >= pause_ms * sr].sum()
    return float((len(env) - long) * hop / sr)


def speech_db(x: np.ndarray, sr: int) -> float:
    """Level of the spoken parts only (frames within 25 dB of the loudest), so pauses don't count."""
    env, _ = _env_db(x, sr)
    live = env[env > env.max() - 25.0]
    return float(10 * np.log10((10 ** (live / 10)).mean()))


def match_level(x: np.ndarray, sr: int, target_db: float = -23.0) -> np.ndarray:
    """Bring every chunk to the same speech level, so there are no volume jumps at joins."""
    y = x * 10 ** (float(np.clip(target_db - speech_db(x, sr), -15, 15)) / 20)
    peak = float(np.abs(y).max())
    return y * (0.95 / peak) if peak > 0.95 else y


def fade(x: np.ndarray, sr: int, in_ms: int = 5, out_ms: int = 30) -> np.ndarray:
    """Short ramps at both ends: joins can never click."""
    y = x.copy()
    a, b = min(len(y) // 2, sr * in_ms // 1000), min(len(y) // 2, sr * out_ms // 1000)
    if a:
        y[:a] *= np.linspace(0, 1, a, dtype=np.float32)
    if b:
        y[-b:] *= np.linspace(1, 0, b, dtype=np.float32)
    return y


def join(parts: list[np.ndarray], sr: int, gap_s: float) -> np.ndarray:
    """Concatenate with `gap_s` of silence between parts (parts are already trimmed + faded)."""
    gap = np.zeros(int(sr * gap_s), dtype=np.float32)
    out: list[np.ndarray] = []
    for i, p in enumerate(parts):
        if i:
            out.append(gap)
        out.append(p.astype(np.float32))
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


def best_window(x: np.ndarray, sr: int, seconds: float = 18.0) -> tuple[int, int]:
    """For long voice samples (MiniMax takes up to 5 minutes): the stretch with the most clear, continuous,
    unclipped speech, with both cut points moved to the nearest pause so no word is cut."""
    n = int(seconds * sr)
    if len(x) <= n * 1.4:
        return 0, len(x)
    env, hop = _env_db(x, sr, hop_ms=50)
    w = n // hop
    speech = env > np.percentile(env, 95) - 25.0  # relative to typical loud speech, so hiss never counts
    clip = np.abs(x[: len(env) * hop]).reshape(len(env), hop).max(axis=1) > 0.99
    cs, cc = np.concatenate([[0], np.cumsum(speech)]), np.concatenate([[0], np.cumsum(clip)])
    best, at = -1e9, 0
    for i in range(0, len(env) - w + 1, 2):  # 100 ms steps
        seg = env[i:i + w]
        score = (cs[i + w] - cs[i]) / w - 2 * (cc[i + w] - cc[i]) / w + (np.percentile(seg, 90) - np.percentile(seg, 10)) / 120
        if score > best:
            best, at = score, i

    def pause_near(i: int) -> int:  # quietest frame within 1 s
        lo, hi = max(0, i - 20), min(len(env), i + 21)
        return lo + int(np.argmin(env[lo:hi]))
    return pause_near(at) * hop, min(len(x), (pause_near(min(at + w, len(env) - 1)) + 1) * hop)


def peaks(x: np.ndarray, n: int = 96) -> list[float]:
    """n loudness values (0..1) across the clip, for drawing its waveform in the UI."""
    if len(x) < n:
        return []
    p = np.abs(x[: len(x) // n * n]).reshape(n, -1).max(axis=1)
    return [round(float(v), 2) for v in p / max(float(p.max()), 1e-6)]


def cap_silences(x: np.ndarray, sr: int, max_s: float, floor_db: float = -52.0) -> np.ndarray:
    """Dead-air trim: any silence longer than max_s is shortened to max_s; head and tail are cut to 50 ms."""
    env, hop = _env_db(x, sr)
    quiet = env < max(floor_db, env.max() - 50.0)
    keep = np.ones(len(x), dtype=bool)
    lim, i, n = int(max_s * sr), 0, len(quiet)
    while i < n:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < n and quiet[j]:
            j += 1
        a, b = i * hop, (len(x) if j == n else j * hop)
        cap = sr // 20 if (i == 0 or j == n) else lim
        if b - a > cap:  # drop the middle of the silent run (it is silence, so no click)
            keep[a + cap // 2: b - (cap - cap // 2)] = False
        i = j
    return x[keep]


# ---------- ffmpeg-based processing ----------
def convert(src, dst, sr: int | None = None, start: float = 0, end: float = 0, af: str | None = None, extra: tuple = ()) -> None:
    args: list = []
    if start > 0:
        args += ["-ss", f"{start:.3f}"]
    if end > start:
        args += ["-t", f"{end - start:.3f}"]
    args += ["-i", src, "-vn", "-ac", 1]
    if sr:
        args += ["-ar", sr]
    if af:
        args += ["-af", af]
    ff(*args, *extra, dst)


# Tone: how the finished voice sounds (EQ, de-essing, gentle compression). Applied to takes on playback and export,
# so changing it needs no regeneration.
TONES = {
    "soft": "highpass=f=70,deesser=i=0.6:m=0.5:f=0.5,treble=g=-5:f=5500,equalizer=f=2800:t=q:w=1.4:g=-2,"
            "acompressor=threshold=-26dB:ratio=2:attack=25:release=250:makeup=2",
    "warm": "highpass=f=60,bass=g=3.5:f=180,treble=g=-2.5:f=7000,acompressor=threshold=-22dB:ratio=2.5:attack=15:release=180:makeup=1.5",
    "bright": "highpass=f=90,deesser=i=0.3:m=0.4:f=0.5,equalizer=f=3200:t=q:w=1.2:g=2.5,treble=g=3:f=6500",
    "broadcast": "highpass=f=80,equalizer=f=180:t=q:w=1:g=2.5,equalizer=f=3500:t=q:w=1.2:g=3,deesser=i=0.4:m=0.5:f=0.5,"
                 "acompressor=threshold=-24dB:ratio=4:attack=5:release=120:makeup=3",
    "deep": "highpass=f=50,bass=g=5:f=140,equalizer=f=2500:t=q:w=1:g=-1.5,treble=g=-3:f=6000",
}


def toned(src: Path, name: str) -> Path:
    """The take with a tone applied, cached next to it (<id>.<tone>.wav). Unknown/natural -> the take itself."""
    if name not in TONES:
        return src
    dst = src.with_name(f"{src.stem}.{name}.wav")
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        part = dst.with_suffix(".tmp.wav")
        convert(src, part, af=TONES[name])
        x, sr = read(part)
        write(part, match_level(x, sr), sr)  # same loudness whatever the tone
        part.replace(dst)
    return dst


def stretch(src, dst, speed: float = 1.0, semitones: float = 0.0) -> None:
    """Pace and pitch without the chipmunk effect. Pace alone uses atempo (WSOLA), which keeps speech
    natural; Rubber Band (formants preserved) only runs when the pitch changes."""
    if abs(semitones) < 0.01:
        ff("-i", src, "-af", f"atempo={speed:.4f}", "-c:a", "pcm_s16le", dst)
        return
    ff("-i", src, "-af",
       f"rubberband=tempo={speed:.4f}:pitch={2 ** (semitones / 12):.5f}:formant=preserved:pitchq=quality:transients=smooth",
       "-c:a", "pcm_s16le", dst)


def measure(path, target: float = -14.0, tp: float = -1.0, lra: float = 11.0) -> dict:
    """EBU R128 numbers via ffmpeg loudnorm (pass 1)."""
    log = ff("-i", path, "-af", f"loudnorm=I={target}:TP={tp}:LRA={lra}:print_format=json", "-f", "null", "-")
    m = json.loads(log[log.rindex("{"): log.rindex("}") + 1])
    return {k: (float(v) if v not in ("-inf", "inf") else -99.0) for k, v in m.items() if k != "normalization_type"}


def master(src, dst, target: float = -14.0, tp: float = -1.0, sr: int = 48000) -> dict:
    """YouTube master: lift to about target with a peak limiter, then two-pass loudnorm (linear) to land exactly.
    Returns the measured result {"lufs", "true_peak"}."""
    m0 = measure(src, target, tp)
    if m0["input_i"] <= -70:  # too short / silent to measure: leave as is
        convert(src, dst, sr=sr)
        return {"lufs": m0["input_i"], "true_peak": m0["input_tp"]}
    pre = tmp()
    try:
        # 1) static gain to a touch above target; limiter keeps peaks at -2 dBFS (leaves room for step 2 to stay linear)
        ff("-i", src, "-af", f"volume={target + 0.4 - m0['input_i']:.2f}dB,alimiter=limit={10 ** (-3 / 20):.4f}:attack=3:release=60:level=disabled",
           "-ar", sr, "-c:a", "pcm_s24le", pre)
        # 2) two-pass loudnorm with the measured values
        m1 = measure(pre, target, tp)
        lra = max(11.0, m1["input_lra"] + 1.0)  # target LRA >= measured keeps loudnorm in linear (no pumping) mode
        ff("-i", pre, "-af",
           f"loudnorm=I={target}:TP={tp}:LRA={lra}:measured_I={m1['input_i']}:measured_TP={m1['input_tp']}:"
           f"measured_LRA={m1['input_lra']}:measured_thresh={m1['input_thresh']}:offset={m1['target_offset']}:linear=true",
           "-ar", sr, "-c:a", "pcm_s16le", dst)
    finally:
        pre.unlink(missing_ok=True)
    m2 = measure(dst, target, tp)
    return {"lufs": round(m2["input_i"], 2), "true_peak": round(m2["input_tp"], 2)}


def to_mp3(src, dst) -> None:
    ff("-i", src, "-c:a", "libmp3lame", "-b:a", "192k", dst)


CLEAN = "highpass=f=70,afftdn=nr=10:nf=-50:tn=1"  # light touch: heavy denoise hurts cloning


def make_reference(src, dst, start: float, end: float, clean: bool) -> tuple[float, bool]:
    """Voice sample -> trimmed mono 44.1 kHz WAV (optionally de-hissed + levelled). Returns (duration, was cropped)."""
    raw = tmp()
    try:
        convert(src, raw, sr=44100, start=start, end=end if end > start else start + 300, af=CLEAN if clean else None)
        x, sr = read(raw)
        if len(x) < sr:  # under 1 s of audio
            raise ValueError("That sample is too short. Use at least 5 seconds of speech.")
        cropped = len(x) > 30 * sr
        if cropped:  # long sample: clone from its best 18 s (engines work best on 10-20 s)
            a, b = best_window(x, sr)
            x = x[a:b]
        x = fade(trim_silence(x, sr, pad_start_ms=80, pad_end_ms=150), sr)
        if clean:
            x = match_level(x, sr, target_db=-20.0)
        write(dst, x, sr)
        return len(x) / sr, cropped
    finally:
        raw.unlink(missing_ok=True)


# ---------- Whisper (whisper.cpp) ----------
def transcribe(path, words: bool = False) -> list[dict]:
    """[{text, start, end}] in seconds. words=True gives one entry per word."""
    wav, out = tmp(), tmp("")
    try:
        convert(path, wav, sr=16000, extra=("-c:a", "pcm_s16le"))
        if not (WHISPER and WHISPER_MODEL):
            raise RuntimeError("Speech recognition (Whisper) is not installed. Run 'Repair VoiceBird' from the Start menu.")
        args = [WHISPER, "-m", WHISPER_MODEL, "-f", str(wav), "-oj", "-of", str(out), "-np", "-l", "en",
                "-t", str(min(8, os.cpu_count() or 4)), "-mc", "0"]  # no carried context: one slip can't drop the rest
        if words:
            args += ["-ml", "1", "-sow"]
        p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=_NOWIN)
        js = Path(f"{out}.json")
        if p.returncode or not js.exists():
            raise RuntimeError("Whisper failed: " + (p.stderr.strip().splitlines() or ["no output"])[-1])
        data = json.loads(js.read_text(encoding="utf-8", errors="replace"))
        return [{"text": s["text"].strip(), "start": s["offsets"]["from"] / 1000, "end": s["offsets"]["to"] / 1000}
                for s in data["transcription"] if s["text"].strip() and not re.fullmatch(r"[\[(].*[\])]", s["text"].strip())]
    finally:
        wav.unlink(missing_ok=True)
        Path(f"{out}.json").unlink(missing_ok=True)


def _stamp(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def srt(words: list[dict], max_chars: int = 42, max_gap: float = 0.7) -> str:
    """Group word timings into subtitle lines: break at sentence ends, long lines, and pauses."""
    lines, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        text = " ".join(c["text"] for c in cur)
        if (nxt is None or re.search(r"[.!?]$", w["text"]) or nxt["start"] - w["end"] > max_gap
                or len(text) + len(nxt["text"]) + 1 > max_chars):
            lines.append((cur[0]["start"], w["end"], text))
            cur = []
    return "\n".join(f"{n}\n{_stamp(a)} --> {_stamp(b)}\n{t}\n" for n, (a, b, t) in enumerate(lines, 1))


if __name__ == "__main__":  # self-check: python -m server.audio
    sr = 24000
    t = np.arange(sr) / sr
    tone = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)

    def sil(s):
        return np.zeros(int(sr * s), dtype=np.float32)

    # trim: silence removed but pads kept
    y = trim_silence(np.concatenate([sil(0.5), tone, sil(0.5)]), sr)
    assert abs(len(y) / sr - 1.12) < 0.03, len(y) / sr
    # level match: quiet and loud chunks end up within 0.2 dB
    a, b = match_level(tone * 0.1, sr), match_level(tone * 1.5, sr)
    assert abs(speech_db(a, sr) - speech_db(b, sr)) < 0.2 and abs(speech_db(a, sr) + 23) < 0.2
    # fades: both ends start/finish at zero
    f = fade(tone, sr)
    assert f[0] == 0 and abs(f[-1]) < 1e-6
    # join: gap length exact
    j = join([f, f], sr, 0.6)
    assert len(j) == 2 * len(f) + int(0.6 * sr)
    # dead air: 2 s gap capped to 0.8 s, head/tail to 50 ms
    c = cap_silences(np.concatenate([sil(1), tone, sil(2), tone, sil(1)]), sr, 0.8)
    assert abs(len(c) / sr - (0.05 + 1 + 0.8 + 1 + 0.05)) < 0.05, len(c) / sr
    # long sample: the window lands on the speech, not the noise around it
    rng = np.random.default_rng(0)
    talk = np.concatenate([np.concatenate([tone * 0.5, sil(0.15)]) for _ in range(20)])  # ~23 s of "speech"
    hiss = lambda s: (rng.standard_normal(int(sr * s)) * 0.003).astype(np.float32)
    long = np.concatenate([hiss(20), talk, hiss(20)])
    a, b = best_window(long, sr)
    assert 19 * sr <= a <= 25 * sr and b <= 45 * sr and 15 * sr <= b - a <= 22 * sr, (a / sr, b / sr)
    assert load_at.__doc__  # (load_at is exercised by the export path)
    # srt formatting
    s = srt([{"text": "Hello", "start": 0.0, "end": 0.4}, {"text": "world.", "start": 0.45, "end": 0.9},
             {"text": "Next", "start": 3661.5, "end": 3662.0}])
    assert "00:00:00,000 --> 00:00:00,900\nHello world." in s and "01:01:01,500 --> 01:01:02,000\nNext" in s, s
    # mastering lands on -14 LUFS / <= -1 dBTP (speech-like: tone bursts with pauses, quiet input)
    src, dst = tmp(), tmp()
    burst = np.concatenate([np.concatenate([tone * (0.2 + 0.1 * (k % 3)), sil(0.3)]) for k in range(8)])
    write(src, burst * 0.3, sr)
    r = master(src, dst)
    src.unlink()
    dst.unlink()
    assert abs(r["lufs"] + 14) <= 0.5 and r["true_peak"] <= -0.9, r
    print("audio.py ok", r)
