# Jammer analyzer

Offline audio analysis. Produces a beat grid, key, chords and draft tablature from an
audio file.

## Why this exists

Spotify's `/audio-features` and `/audio-analysis` endpoints were deprecated on
2024-11-27 and return `403` for any app created after that date. They were the free
source of BPM, key and time signature.

What this produces is better anyway: a **beat grid with downbeats** rather than one
averaged BPM number. A tab cursor needs bars, and a single tempo figure can't give you
those — nor can it survive a track that drifts or changes metre.

## It analyses files, not streams

Spotify and YouTube audio is DRM-protected. The decrypted samples never leave the
Widevine pipeline, so they cannot be captured, analysed, or sent here. This service
takes audio files the user already has.

**Do not add a URL endpoint.** "Paste a YouTube link" is the line between a tool that
analyses music you own and a stream-ripper.

## Running

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

`GET /health` reports whether a GPU was found. On CPU, Demucs takes several minutes per
track; on GPU, seconds.

## API

```
POST   /analyze          multipart file upload  -> { jobId }
GET    /jobs/{id}                               -> { status, progress, result, error }
DELETE /jobs/{id}                               -> { deleted }
```

Jobs are queued rather than awaited, because a four-minute HTTP request dies in transit.

## Stage reliability

Ship in this order. Each stage degrades independently, so a failure downstream doesn't
cost you the run.

| Stage | Typical accuracy | Notes |
|---|---|---|
| Beat grid | ~95% | 4/4 pop/rock with a clear backbeat |
| Key | ~85% | Modal material reads as its relative major |
| Bass tab | ~80% | Monophonic after separation — the easy case |
| Chords | ~75% | Good on triads and sevenths, poor on extensions |
| Drums | ~70% | Kick/snare/hat fine, toms and cymbal types poor |
| Guitar tab | ~50% | Polyphonic transcription is an open research problem |

Beat grid + chords alone is a shippable jamming tool. Don't gate v1 on guitar tab.

## Treat output as a draft

Every result carries a confidence, and `warnings` explains what the pipeline was unsure
about. Surface low confidence in the UI rather than asserting a wrong answer
confidently — and persist user corrections. A chart that improves each time someone
fixes it is worth more than a slightly better model.

## Swapping in better models

The pipeline is deliberately modular. Each of these is a drop-in upgrade:

- **Beats:** `beat-this` (transformer) or `allin1` (also gives sections) instead of madmom
- **Chords:** a trained BTC or Axial-RoFormer + semi-CRF model instead of template matching
- **Fretting:** Fretting-Transformer (2025) instead of the Viterbi cost model
