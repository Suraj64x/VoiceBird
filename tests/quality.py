"""Quality checks for VoiceBird output: word error rate, speaker similarity, join seams, loudness, DNSMOS.

    python -m tests.quality wer  <audio> "<expected text>"
    python -m tests.quality sim  <a> <b>
    python -m tests.quality loud <audio>
    python -m tests.quality mos  <audio>
    python -m tests.quality            # self-check (same as: selftest)

Run from the app folder so `server` is importable. No torch anywhere.

Speaker model (similarity)
  Name:    3D-Speaker ERes2Net, speech_eres2net_sv_en_voxceleb_16k (192-dim, trained on VoxCeleb, 16 kHz)
  File:    models/speaker/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx (26,485,263 bytes)
  Source:  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx
           (ONNX export of https://www.modelscope.cn/models/iic/speech_eres2net_sv_en_voxceleb_16k)
  Licence: Apache-2.0 (ModelScope model card + https://github.com/modelscope/3D-Speaker/blob/main/LICENSE)
  Runtime: sherpa-onnx (Apache-2.0), CPU.

DNSMOS models (dnsmos)
  Files:   models/speaker/dnsmos/sig_bak_ovr.onnx (1,157,965 bytes, P.835 SIG/BAK/OVRL)
           models/speaker/dnsmos/model_v8.onnx    (224,860 bytes, P.808 MOS)
  Source:  https://github.com/microsoft/DNS-Challenge/tree/master/DNSMOS/DNSMOS
  Licence: CC BY 4.0 (repo LICENSE). The maths follows the repo's dnsmos_local.py (MIT, LICENSE-CODE).
  Runtime: onnxruntime, CPU.
"""
import json
import os
import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from server.audio import _env_db, measure, read, transcribe
from server.config import FFMPEG, MODELS

_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
SPEAKER_MODEL = MODELS / "speaker" / "3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx"
DNSMOS_DIR = MODELS / "speaker" / "dnsmos"
SAME_SPEAKER = 0.55  # cosine at or above this = same voice (measured: same 0.78-0.95, different 0.01-0.33)


# ---------- 1. word error rate ----------
_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split()
_SAME = {str(i): w for i, w in enumerate(_ONES)}  # digits 0-99 -> words, so "12" == "twelve" and "21" == "twenty-one"
_SAME.update({str(20 + 10 * t + o): _TENS[t] + (" " + _ONES[o] if o else "") for t in range(8) for o in range(10)})
_SAME.update({"100": "one hundred", "1000": "one thousand", "ok": "okay", "alright": "all right", "vs": "versus",
              "mr": "mister", "mrs": "missus", "dr": "doctor", "1st": "first", "2nd": "second", "3rd": "third"})


def _words(text: str) -> list[str]:
    """Lowercase words with formatting differences removed (punctuation, hyphens, 100k vs 100,000, 12 vs twelve...)."""
    t = text.lower()
    t = re.sub(r"\[[^\]]*\]|\([^)]*\)|<[^>]*>", " ", t)   # [BLANK_AUDIO], (laughs), <pause tags>
    t = t.replace("%", " percent ").replace("&", " and ")
    t = re.sub(r"(?<=\d),(?=\d{3})", "", t)               # 100,000 -> 100000
    t = re.sub(r"(\d)k\b", r"\g<1>000", t)                # 100k -> 100000
    t = re.sub(r"['’`]", "", t)                           # that's -> thats
    t = re.sub(r"[^a-z0-9]+", " ", t)                     # punctuation, hyphens, $ -> space
    return " ".join(_SAME.get(w, w) for w in t.split()).split()


def _edits(ref: list[str], hyp: list[str]) -> int:
    """Word-level Levenshtein distance (substitutions + deletions + insertions)."""
    # ponytail: plain O(len(ref) * len(hyp)) Python; ~2 s for a 2000-word script. Swap for rapidfuzz if that ever hurts.
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1]


def _score(expected_text: str, hyp: str) -> dict:
    ref = _words(expected_text)
    errors = _edits(ref, _words(hyp))
    return {"wer": round(min(1.0, errors / max(1, len(ref))), 4), "ref_words": len(ref), "errors": errors, "hyp": hyp}


def wer(audio_path, expected_text: str) -> dict:
    """Whisper the audio and compare with the script. {"wer" 0..1 (capped), "ref_words", "errors", "hyp"}."""
    return _score(expected_text, " ".join(s["text"] for s in transcribe(audio_path)))


# ---------- 2. speaker similarity ----------
def _pcm16k(path) -> np.ndarray:
    """Any audio file -> mono 16 kHz float32 samples."""
    p = subprocess.run([FFMPEG, "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                       capture_output=True, creationflags=_NOWIN)
    if p.returncode:
        raise RuntimeError("ffmpeg: " + (p.stderr.decode("utf-8", "replace").strip().splitlines() or ["failed"])[-1])
    return np.frombuffer(p.stdout, dtype=np.float32)


@lru_cache(maxsize=1)
def _extractor():
    import sherpa_onnx
    return sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(SPEAKER_MODEL), num_threads=min(4, os.cpu_count() or 2)))


def embed(path) -> np.ndarray:
    """Unit-length speaker embedding. Long files: mean over equal windows of about 6 s (deterministic, bounded memory)."""
    x = _pcm16k(path)
    if len(x) < 16000:
        raise ValueError(f"{path}: need at least 1 s of audio for a speaker embedding (3 s+ for a stable score)")
    ex, out = _extractor(), []
    for part in np.array_split(x, max(1, round(len(x) / (6 * 16000)))):
        s = ex.create_stream()
        s.accept_waveform(16000, part)
        s.input_finished()
        e = np.asarray(ex.compute(s), dtype=np.float64)
        out.append(e / np.linalg.norm(e))
    e = np.mean(out, axis=0)
    return e / np.linalg.norm(e)


def similarity(path_a, path_b) -> float:
    """Cosine similarity of the two voices, -1..1. Same speaker scores >= SAME_SPEAKER."""
    return float(embed(path_a) @ embed(path_b))


# ---------- 3. joins ----------
def _side_db(env: np.ndarray, n: int) -> float | None:
    """Speech level of the nearest n live frames. `env` = 10 ms frame levels, nearest to the join first.
    Live = within 25 dB of the loudest frame on that side (the server.audio.speech_db rule), so gaps and pauses are skipped."""
    if not len(env) or env.max() < -90:  # nothing but silence on this side
        return None
    live = env[env > env.max() - 25.0][:n]
    return round(float(10 * np.log10((10 ** (live / 10)).mean())), 2)


def _click(x: np.ndarray, d: np.ndarray, a: int, b: int, sr: int, p999: float, peak: float) -> bool:
    """Is there an abrupt discontinuity in x[a:b]? d[n] = |x[n] - x[n-1]|. Thresholds were set on real speech:
    untouched speech / TTS reaches 2.4x p999, an isolation ratio of 3.3, and 1% of peak next to silence (847 pauses);
    a 5 ms linear fade can reach 10% of peak in its first 0.5 ms at the very worst."""
    K = 16
    a, b = max(a, K), min(b, len(x) - K)
    if b <= a or p999 <= 0:
        return False
    step = d[a:b]
    dw = sliding_window_view(d[a - K: b + K], 2 * K + 1)                       # row i: d[n-K .. n+K], n = a + i
    around = np.maximum(dw[:, :K - 2].max(axis=1), dw[:, K + 3:].max(axis=1))  # the neighbours, minus the step's own samples
    if np.any((step > 6 * p999)                                # a jump far beyond anything the speech in this file does
              | ((step > 6 * around) & (step > 0.5 * p999))):  # or an isolated one: nothing like it 16 samples either side
        return True
    # straight out of / into digital silence: loud sound within 0.5 ms of a silent run (measured on amplitude, not on
    # one sample step, so it still works after the file was resampled)
    mag = np.abs(x[a:b])
    sil = np.concatenate([[False], mag <= 1e-3 * peak, [False]])
    flips = np.flatnonzero(sil[1:] != sil[:-1])                # silent runs are mag[flips[0]:flips[1]], mag[flips[2]:flips[3]]...
    w = max(2, int(0.0005 * sr))
    return any(e - s >= 0.005 * sr and max(mag[max(0, s - w): s].max(initial=0), mag[e: e + w].max(initial=0)) > 0.12 * peak
               for s, e in zip(flips[::2].tolist(), flips[1::2].tolist()))


def joins(wav_path, join_times: list[float], window_s: float = 0.4) -> list[dict]:
    """Check each join (seconds). {"time", "before_db", "after_db", "delta_db", "click"} per join.
    Levels are the nearest `window_s` of actual speech on each side. The click window is the whole silent gap
    around the join plus 30 ms of audio on each side (so any time inside the gap finds both chunk edges);
    with no gap it is the join time +/- 30 ms.
    Reading delta_db: ordinary prosody moves it too. Across 250 natural pauses in one narration |delta_db| was
    3.7 dB median / 9.7 dB p95 at window_s=0.4, and 0.9 / 3.2 dB at window_s=2.0. Use 2.0 to judge level matching."""
    x, sr = read(wav_path)
    env, hop = _env_db(x, sr)
    quiet = env < max(-60.0, env.max() - 45.0)
    d = np.abs(np.diff(x, prepend=x[:1]))
    p999, peak = float(np.percentile(d, 99.9)), float(np.abs(x).max())
    n, pad = max(1, round(window_s * sr / hop)), int(0.03 * sr)
    out = []
    for t in join_times:
        s = min(max(int(t * sr), 0), len(x) - 1)
        i = min(s // hop, len(env) - 1)
        lo, hi, a, b = i, i - 1, s, s                        # no gap: split exactly at the join
        near = np.flatnonzero(quiet[max(0, i - 3): i + 4]) + max(0, i - 3)   # a silent frame within 30 ms of the join
        if len(near):
            lo = hi = int(near[np.argmin(np.abs(near - i))])
            while lo > 0 and quiet[lo - 1]:
                lo -= 1
            while hi < len(quiet) - 1 and quiet[hi + 1]:
                hi += 1
            a, b = lo * hop, (hi + 1) * hop
        before, after = _side_db(env[max(0, lo - 4 * n): lo][::-1], n), _side_db(env[hi + 1: hi + 1 + 4 * n], n)
        out.append({"time": round(float(t), 3), "before_db": before, "after_db": after,
                    "delta_db": None if before is None or after is None else round(after - before, 2),
                    "click": _click(x, d, a - pad, b + pad, sr, p999, peak)})
    return out


def joins_summary(results: list[dict]) -> dict:
    deltas = [abs(r["delta_db"]) for r in results if r["delta_db"] is not None]
    return {"max_abs_delta_db": max(deltas, default=0.0), "clicks": sum(r["click"] for r in results), "n": len(results)}


# ---------- 4. loudness ----------
def loudness(path) -> dict:
    """EBU R128 integrated loudness (LUFS) and true peak (dBTP)."""
    m = measure(path)
    return {"lufs": m["input_i"], "true_peak": m["input_tp"]}


# ---------- 5. DNSMOS (speech quality MOS, 1..5) ----------
# Port of microsoft/DNS-Challenge DNSMOS/dnsmos_local.py (non-personalized): 16 kHz mono, 9.01 s windows hopped 1 s.
_POLY = (np.poly1d([-0.08397278, 1.22083953, 0.0052439]),    # SIG
         np.poly1d([-0.13166888, 1.60915514, -0.39604546]),  # BAK
         np.poly1d([-0.06766283, 1.11546468, 0.04602535]))   # OVRL


@lru_cache(maxsize=1)
def _mos_sessions():
    import onnxruntime as ort
    return tuple(ort.InferenceSession(str(DNSMOS_DIR / f), providers=["CPUExecutionProvider"]) for f in ("sig_bak_ovr.onnx", "model_v8.onnx"))


@lru_cache(maxsize=1)
def _mel_basis() -> np.ndarray:
    """librosa.filters.mel(sr=16000, n_fft=321, n_mels=120): Slaney mel scale, slaney area normalisation."""
    f_sp, min_log_hz, logstep = 200.0 / 3, 1000.0, np.log(6.4) / 27.0
    min_log_mel = min_log_hz / f_sp
    m = np.linspace(0.0, min_log_mel + np.log(8000.0 / min_log_hz) / logstep, 122)
    mel_f = np.where(m < min_log_mel, m * f_sp, min_log_hz * np.exp(logstep * (m - min_log_mel)))
    ramps = mel_f[:, None] - np.fft.rfftfreq(321, 1 / 16000)[None, :]
    fdiff = np.diff(mel_f)[:, None]
    w = np.maximum(0, np.minimum(-ramps[:-2] / fdiff[:-1], ramps[2:] / fdiff[1:]))
    return (w * (2.0 / (mel_f[2:] - mel_f[:-2]))[:, None]).astype(np.float32)


def _logmel(seg: np.ndarray) -> np.ndarray:
    """(librosa.power_to_db(librosa.feature.melspectrogram(y, sr=16000, n_fft=321, hop_length=160, n_mels=120), ref=np.max) + 40) / 40,
    transposed to (frames, 120). Centred STFT with reflect padding (the librosa default when the reference script was written)."""
    y = np.pad(seg.astype(np.float64), 160, mode="reflect")
    hann = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(321) / 321)  # periodic, like scipy get_window("hann", 321)
    power = np.abs(np.fft.rfft(sliding_window_view(y, 321)[::160] * hann, axis=1)) ** 2
    mel = power @ _mel_basis().T
    db = 10 * np.log10(np.maximum(1e-10, mel)) - 10 * np.log10(max(1e-10, float(mel.max())))
    return ((np.maximum(db, db.max() - 80.0) + 40) / 40).astype(np.float32)


def dnsmos(path) -> dict:
    """DNSMOS P.835 {"sig" speech quality, "bak" background, "ovrl" overall} and "p808" MOS, each about 1..5 (higher = better)."""
    x = _pcm16k(path)
    if not len(x):
        raise ValueError(f"{path}: no audio")
    n = int(9.01 * 16000)
    while len(x) < n:  # short clips are repeated, as in the reference
        x = np.append(x, x)
    sbo, p808 = _mos_sessions()
    rows = []
    # ponytail: one window per second like the reference, ~0.4 s CPU each (a 5 min file takes ~2 min). Hop wider if that hurts.
    for i in range(int(np.floor(len(x) / 16000) - 9.01) + 1):
        seg = x[i * 16000: i * 16000 + n]
        raw = sbo.run(None, {"input_1": seg[None, :]})[0][0]
        rows.append([float(p(v)) for p, v in zip(_POLY, raw)]
                    + [float(p808.run(None, {"input_1": _logmel(seg[:-160])[None]})[0][0][0])])
    return dict(zip(("sig", "bak", "ovrl", "p808"), (round(float(v), 3) for v in np.mean(rows, axis=0))))


# ---------- self-check ----------
def selftest() -> None:
    import shutil
    from server.audio import convert, fade, ff, join, speech_db, write

    # SELFTEST_VOICE: a clip of the voice whose words are `truth`; SELFTEST_OTHER / _OTHER2: two clips of another speaker
    jason = Path(os.environ.get("SELFTEST_VOICE", "voice.mp3"))
    truth = ("Today I want to show you five mobile app ideas that's making at least 100k per month. And what's crazy is that "
             "all of these apps were launched less than 12 months ago. In fact one of the apps here is making 500k per month "
             "and they launched it just three months ago. And these are not huge apps.")
    wrong = ("The quiet river carried old wooden boats past sleeping villages while children collected smooth grey stones "
             "along its muddy banks every single autumn evening before the first heavy snow finally arrived.")
    other, other2 = (Path(os.environ.get(k, f"{k.lower()}.mp3")) for k in ("SELFTEST_OTHER", "SELFTEST_OTHER2"))
    for f in (jason, other, other2, SPEAKER_MODEL):
        assert f.exists(), f"self-check needs {f}"
    tmp = Path(__file__).resolve().parent / ".selftest"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    try:
        # --- WER: pure text first (exact), then real audio
        assert _score("It's OK - 20% of twenty-one, Mr. Smith!", "its okay 20 percent of 21 mister smith")["errors"] == 0
        assert _score("making 100k per month", "Making $100,000 per month.")["errors"] == 0
        assert _score("a b c d", "a x c")["errors"] == 2 and _score("a b c d", "a x c")["wer"] == 0.5
        good = wer(jason, truth)
        bad = _score(wrong, good["hyp"])  # same as wer(jason, wrong), without running Whisper a second time
        print(f"wer   true transcript  {good['wer']:.3f} ({good['errors']}/{good['ref_words']})  hyp: {good['hyp']}")
        print(f"wer   wrong sentence   {bad['wer']:.3f} ({bad['errors']}/{bad['ref_words']})")
        assert good["wer"] < 0.1 and bad["wer"] > 0.6, (good, bad)
        extra = _score(truth + " four more words here", good["hyp"])
        assert extra["errors"] == good["errors"] + 4, extra  # 4 words never spoken = exactly 4 more errors

        # --- similarity
        wav = tmp / "jason24k.wav"
        convert(jason, wav, sr=24000)
        half_a, half_b, shifted, sped = tmp / "jason_a.wav", tmp / "jason_b.wav", tmp / "jason_pitch.wav", tmp / "jason_asetrate.wav"
        convert(jason, half_a, start=0, end=7)
        convert(jason, half_b, start=7, end=14)
        ff("-i", wav, "-af", "rubberband=pitch=1.35", shifted)
        ff("-i", wav, "-af", "asetrate=24000*1.25,aresample=24000", sped)
        sim = {"jason 1st half vs 2nd half (same speaker)": similarity(half_a, half_b),
               "TTS voice, file 1 vs file 2 (same speaker)": similarity(other, other2),
               "jason vs TTS voice (different speaker)": similarity(jason, other),
               "jason half vs TTS voice file 2 (different)": similarity(half_a, other2),
               "jason vs jason pitch x1.35 (rubberband)": similarity(jason, shifted),
               "jason vs jason asetrate x1.25 (chipmunk)": similarity(jason, sped)}
        for k, v in sim.items():
            print(f"sim   {k:44s} {v:+.3f}")
        same, diff = list(sim.values())[:2], list(sim.values())[2:]
        print(f"sim   same >= {min(same):.3f}, different <= {max(diff):.3f}, threshold SAME_SPEAKER = {SAME_SPEAKER}")
        assert min(same) > SAME_SPEAKER + 0.15 and max(diff) < SAME_SPEAKER - 0.15, sim
        assert similarity(half_a, half_b) == same[0], "embedding is not deterministic"

        # --- joins: two real speech segments, 150 ms gap
        x, sr = read(wav)
        cut_a = int(4.0 * sr) + int(np.argmax(np.abs(x[int(4.0 * sr): int(4.4 * sr)])))  # cuts land on a waveform peak
        cut_b = int(5.8 * sr) + int(np.argmax(np.abs(x[int(5.8 * sr): int(6.2 * sr)])))
        seg_a = x[int(1.0 * sr): cut_a + 1]
        seg_b = seg_a[::-1].copy()  # the same speech mirrored: both sides of the join are equally loud by construction
        t = len(seg_a) / sr + 0.075  # the join: middle of the gap
        clean = join([fade(seg_a, sr), fade(seg_b, sr)], sr, 0.15)
        spike = clean.copy()
        spike[len(seg_a) - int(0.015 * sr)] += 0.5  # one bad sample 15 ms before the gap
        cases = {"clean (faded)": clean, "hard cut": join([seg_a, seg_b], sr, 0.15), "sample spike": spike,
                 "-9 dB jump": join([fade(seg_a, sr), fade(seg_b, sr) * 10 ** (-9 / 20)], sr, 0.15)}
        res = {}
        for name, y in cases.items():
            write(tmp / f"join {name}.wav", y, sr)
            res[name] = joins(tmp / f"join {name}.wav", [t])[0]
            print(f"join  {name:22s} {res[name]}")
        assert not res["clean (faded)"]["click"] and abs(res["clean (faded)"]["delta_db"]) < 1.0
        assert res["hard cut"]["click"] and res["sample spike"]["click"]
        assert not res["-9 dB jump"]["click"] and abs(res["-9 dB jump"]["delta_db"] - (res["clean (faded)"]["delta_db"] - 9)) < 0.3
        assert joins_summary(list(res.values())) == {"max_abs_delta_db": abs(res["-9 dB jump"]["delta_db"]), "clicks": 2, "n": 4}
        # two different real segments, untouched levels: still no click, and delta_db shows ordinary prosody
        seg_c, w = x[cut_b: int(9.0 * sr)], int(0.4 * sr)
        write(tmp / "join real.wav", join([fade(seg_a, sr), fade(seg_c, sr)], sr, 0.15), sr)
        real = joins(tmp / "join real.wav", [t])[0]
        print(f"join  {'two real segments':22s} {real}  (server.audio.speech_db on the 0.4 s either side: "
              f"{speech_db(fade(seg_c, sr)[:w], sr) - speech_db(fade(seg_a, sr)[-w:], sr):+.2f} dB)")
        assert not real["click"]
        for name in ("clean (faded)", "hard cut"):  # the same files after a 48 kHz resample, as the master step does
            ff("-i", tmp / f"join {name}.wav", "-ar", 48000, "-c:a", "pcm_s16le", tmp / "join48.wav")
            r48 = joins(tmp / "join48.wav", [t])[0]
            print(f"join  {name + ' @48k':22s} {r48}")
            assert r48["click"] == (name == "hard cut"), r48
        probes = [round(k * 0.25, 2) for k in range(2, 54)]  # untouched speech must never read as a click
        natural = joins_summary(joins(wav, probes))
        print(f"join  untouched speech, {len(probes)} probe points: {natural}")
        assert natural["clicks"] == 0

        # --- loudness: absolute (997 Hz sine at -20 dBFS RMS is -20 LUFS, -17 dBTP) and relative (known gain)
        sine = (10 ** (-17 / 20) * np.sin(2 * np.pi * 997 * np.arange(5 * 48000) / 48000)).astype(np.float32)
        write(tmp / "sine.wav", sine, 48000)
        tone, base = loudness(tmp / "sine.wav"), loudness(jason)
        ff("-i", jason, "-af", f"volume={-20 - base['lufs']:.3f}dB", "-c:a", "pcm_s24le", tmp / "jason_m20.wav")
        gained = loudness(tmp / "jason_m20.wav")
        print(f"loud  sine built at -20.00 LUFS / -17.00 dBTP reads {tone}")
        print(f"loud  jason as is {base}; gained to -20.00 LUFS reads {gained}")
        assert abs(tone["lufs"] + 20) < 0.3 and abs(tone["true_peak"] + 17) < 0.3, tone
        assert abs(gained["lufs"] + 20) < 0.3, gained

        # --- DNSMOS: clean speech must beat the same speech with noise / clipping / bit-crushing / a robot effect
        s = _pcm16k(jason)
        noise = np.random.default_rng(0).standard_normal(len(s)).astype(np.float32)
        noise *= np.sqrt((s ** 2).mean() / (noise ** 2).mean()) * 10 ** (-5 / 20)  # 5 dB SNR
        lim = 0.1 * float(np.abs(s).max())
        write(tmp / "clean16k.wav", s, 16000)
        ff("-i", tmp / "clean16k.wav", "-af", "afftfilt=real='hypot(re,im)':imag='0':win_size=512:overlap=0.75", tmp / "robot.wav")
        bad_audio = {"+ white noise, 5 dB SNR": (s + noise, 1.0),          # (audio, OVRL drop it must cause)
                     "hard-clipped at 10% of peak": (np.clip(s, -lim, lim) / lim * 0.5, 0.3),
                     "crushed to 4 bit": (np.round(s * 7) / 7, 0.8),
                     "robot voice (phases zeroed)": (read(tmp / "robot.wav")[0], 0.8),
                     "crushed to 8 bit (mild)": (np.round(s * 127) / 127, None)}  # too mild to register: printed, not asserted
        clean_mos = dnsmos(jason)
        print(f"mos   {'clean':28s} {clean_mos}")
        assert clean_mos["ovrl"] > 2.5 and clean_mos["p808"] > 3.0, clean_mos
        for name, (y, need) in bad_audio.items():
            write(tmp / "mos.wav", y, 16000)
            m = dnsmos(tmp / "mos.wav")
            drop = clean_mos["ovrl"] - m["ovrl"]
            print(f"mos   {name:28s} {m}  OVRL drop {drop:.2f}" + ("" if need else "  (no assertion)"))
            assert need is None or drop > need, (name, m)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("quality.py ok")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["selftest"]
    if cmd == "selftest":
        selftest()
    elif cmd == "wer":
        print(json.dumps(wer(args[0], args[1]), indent=1))
    elif cmd == "sim":
        v = similarity(args[0], args[1])
        print(json.dumps({"similarity": round(v, 4), "same_speaker": v >= SAME_SPEAKER, "threshold": SAME_SPEAKER}, indent=1))
    elif cmd == "loud":
        print(json.dumps(loudness(args[0]), indent=1))
    elif cmd == "mos":
        print(json.dumps(dnsmos(args[0]), indent=1))
    else:
        sys.exit(__doc__)
