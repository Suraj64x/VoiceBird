# VoiceBird guide

Everything in detail. The short version is in the [README](../README.md).

## Start
Double-click **`start.bat`**. Your browser opens **http://localhost:7878**. Keep the black window open while you work; close it to stop.
The first start prepares the screen (about 20 s). Starting after that is quick.

## How to use
1. **Voice:** pick one in the left panel (the first voice you add becomes the default). To add one, press **+**, upload or record 10 s to 5 min of clean speech, trim it on the waveform, and tick the permission box. Longer uploads are fine: the app picks the cleanest 18 s. The words in the sample are detected automatically.
2. **Script:** paste it into the middle panel. A blank line starts a new paragraph and becomes a pause (0.6 s by default, adjustable).
3. **Generate** (or **Ctrl+Enter**). Each paragraph gets a take. Press **New take** on any paragraph to redo only that one, then click **Take 1 / Take 2…** to choose. The ▶ in the bottom bar plays the whole script.
4. **Export** (right panel): WAV and/or MP3, one file and/or one per paragraph, an optional YouTube master (dead air trimmed, −14 LUFS / −1 dBTP), and optional subtitles (SRT plus word timings).

Other features:
- **Controls:** pace, pitch, emotion with intensity, style prompt, expressiveness, seed and lock seed.
- **Words tab:** say tricky names right, e.g. `FFmpeg → F F M peg`. It applies to every script.
- **Folders:** with pictures, drag-and-drop, duplicate, search, and light/dark mode.
- **Tone:** Natural, Soft, Warm, Bright, Broadcast or Deep. Changes how every take sounds instantly (playback and export), no regenerating.
- **Styles:** one-click looks (YouTube hype, Soft & gentle, Podcast...) and your own saved ones.
- **Player:** keeps playing while you switch project or folder; pause, skip 5 s, speed 0.75-2x, Space to play/pause, media keys work.
- **One take / By paragraph** switch above the takes; **History** tab of recent takes; download any single take; import a .txt/.md script.
- **Report a bug** (bottom left) with contact links and a button that copies the app details.

Files live in `voices/`, `projects/` (each export is in `projects/<id>/exports/<time>/`) and `words.json`.

## Engines
Chatterbox, Chatterbox Nano and VoxCPM use the **graphics card** (tested on a GTX 1650 with 4 GB) when enough of its memory is free, and fall back to the processor automatically if it is not. Close graphics-heavy apps (games, browsers with many video tabs) for the fastest results. Sopro always runs on the processor. Only one engine is loaded at a time.

The default is **Qwen3**: it continues your voice sample, so it copies the voice, pace and delivery most closely, at about 2 seconds per second of audio. Use Chatterbox Nano when speed matters most, or Chatterbox for an emotion-strength control.

| Engine | Good at | Time per second of audio (graphics card) | Graphics memory | Licence (code / weights) | Monetized YouTube |
|---|---|---|---|---|---|
| Qwen3-TTS 0.6B Base (Alibaba Qwen) | **default**, closest match to the sample's voice, pace and style (similarity 0.87 vs Nano 0.82 on a test voice; pace 4.4 vs the speaker's own 4.2 words/s) | ~2 s | ~2.8 GB | Apache-2.0 / Apache-2.0 | Yes. English only, no emotion controls. Shares Chatterbox Nano's torch install. |
| Chatterbox 0.5B (Resemble AI) | most natural, the only one with a real emotion-strength control | ~4 s | ~2.4 GB | MIT / MIT | Yes. Output has Resemble's inaudible PerTh watermark. Project retired upstream (Aug 2026); pinned version. |
| Chatterbox Nano 110M | fastest, still a good match | ~0.5–0.8 s | ~1.3 GB | MIT / MIT | Yes |
| Sopro v2 Turbo 120M | drafts without the graphics card | ~1 s (processor) | none | Apache-2.0 / Apache-2.0 | Yes |
| VoxCPM 0.5B (OpenBMB) | closest copy of the voice's timbre and accent | ~4 s | ~1.5 GB | Apache-2.0 / Apache-2.0 | Yes |

Emotion and style: no engine that fits this PC understands a free-text style instruction for a cloned voice. Here is what each control actually does:
- **Style prompt:** the app turns words like *hyped, calm, fast, deep* into the emotion, pace and pitch controls.
- **Emotion:** on Chatterbox it drives `exaggeration`. On the other engines it only nudges the pace.
- **Pace and pitch:** every take is first matched to the speaking pace of the voice sample (words per second of talking, within 0.85–1.2×), then your Pace and Pitch settings are applied with Rubber Band, so the voice keeps its character. 1.00× means "as fast as the sample talks".

Researched but **not included**:
- Pocket TTS (CC-BY-4.0): cloning needs a Hugging Face login.
- F5-TTS and E2 (CC-BY-NC), Fish S2-Pro / OpenAudio S1-mini (non-commercial), Spark-TTS, ZipVoice, OmniVoice (non-commercial).
- Too big for a 4 GB graphics card: IndexTTS-2, CosyVoice 3, Higgs Audio, VoxCPM2.

The full research notes are in `engines/SHORTLIST.json` and `engines/*/RESEARCH.json`.

## Test results
`tests.run_quality` writes listenable samples and `samples/report-*.json`. The summary of our own run is at the end of this file.

## Checks you can run
From this folder, the app running:
- `.venv\Scripts\python -m tests.run_quality <engine>`: 150-word script three ways, scored for Whisper WER, speaker similarity to the voice, click/level checks at every join, and loudness.
- `.venv\Scripts\python -m tests.bakeoff gen|score|reveal`: the blind engine comparison (`samples/bakeoff/results.md`).
- `.venv\Scripts\python -m tests.quality selftest`, `-m server.audio`, `-m server.text`: self-checks of the measuring tools.
- `cd ui && node e2e.mjs sopro`: clicks through every feature in a hidden browser (screenshots in `tests/shots/`).

## Reinstall
- **Screen:** `cd ui && npm install`.
- **App:** `uv venv .venv --python 3.11` then `uv pip install --python .venv\Scripts\python.exe fastapi "uvicorn[standard]" python-multipart numpy soundfile sherpa-onnx onnxruntime`.
- **Engines:** each one has its own `engines/<id>/.venv`. See `engines/<id>/worker.py` and its RESEARCH.json for the packages.

Model weights are in `models/hf`. Every cache and temporary file stays inside the app folder.

FFmpeg and whisper.cpp are found on PATH, next to the app folder (`../whisper.cpp`), or wherever `VOICECLONER_FFMPEG`, `VOICECLONER_WHISPER` and `VOICECLONER_WHISPER_MODEL` point (`ggml-medium.en.bin`).

## Known limits
- The first sentence after starting (or after switching voice) is slower, because the engine loads and studies the sample. Later sentences are much quicker.
- With little free graphics memory, Chatterbox runs half on the graphics card and half on the processor, and VoxCPM falls back to the processor (about 9 s per second of audio).
- Clones copy the sample's microphone and room, so a cleaner sample gives a cleaner voice.
- Numbers, symbols and brand names are read as written. Use the Words tab for anything said wrong.

## Test summary (Chatterbox Nano, one test voice, 150-word script)
Made through the app itself and mastered for YouTube. 

| Way | Words wrong | Sounds like the speaker (0–1, same person > 0.55) | Join clicks | Biggest level step at a join | Loudness / peak | Time to make 1 s of audio |
|---|---|---|---|---|---|---|
| Neutral | 2.0 % | 0.85 | 0 of 10 | 2.5 dB | −14.1 LUFS / −1.0 dBTP | 1.1 s (first run, includes loading) |
| Excited + style prompt | 1.3 % | 0.81 | 0 of 10 | 3.2 dB | −14.0 LUFS / −1.2 dBTP | 0.7 s |
| Slow and calm, pitch −2 | 2.0 % | 0.37 | 0 of 10 | 4.4 dB | −14.0 LUFS / −1.3 dBTP | 0.6 s |

The pitch −2 version scores low on "sounds like the speaker" because the voice is deliberately made deeper, and the scorer hears that as a different voice. At normal pitch the clone clearly matches. Speech quality scores (DNSMOS) are 3.1–3.3 overall, which is clean studio-style speech.
