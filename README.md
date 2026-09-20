# Jammer

Play a song from Spotify or YouTube. See its tab, chords and lyrics scroll past a playhead
locked to the actual audio. Jam along.

Like Songsterr, except the chart syncs to **the real recording you're streaming** instead of
a synthesised approximation — and if no chart exists, Jammer transcribes one from audio.

---

## Read this first

`ARCHITECTURE.md` explains three constraints that shape the whole project. The short
version:

1. **Spotify's `audio-features` / `audio-analysis` endpoints are dead** for apps created
   after 27 Nov 2024. No BPM, key or time signature from Spotify. We compute our own —
   and get a full beat grid instead of one averaged number.

2. **Streamed audio is DRM-protected and unreachable from JavaScript.** Live transcription
   of a Spotify or YouTube stream is not possible — not hard, *not possible*. Transcription
   runs offline on a file you supply. The streaming session only reports playhead position.

3. **Tabs are licensed content.** We generate charts or import Guitar Pro files. We don't
   scrape Ultimate Guitar.

Constraint 2 is the one that changes the product. Everything in this repo is built around it.

---

## How it works

Two independent planes joined by **sync points**:

- **Transport** — Spotify / YouTube / a local file. Owns playback. We only ask *where are you?*
- **Chart** — beat grid, chords, tab, lyrics. Owns musical time, in ticks.

Because the chart isn't welded to one audio file, a single chart aligns to the original
master, the remaster, the live cut and the slowed-down practice copy. Each is just a
different sync-point set.

A phase-locked playback clock (`lib/clock.ts`) turns Spotify's coarse, laggy position
reports into a smooth 60 fps cursor without visible jumps.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # add your Spotify client ID
npm run dev
```

Open http://localhost:3000.

**Try the local-file mode first** (`/jam/local`) — drag in an MP3. No auth, no Spotify
Premium, no analyzer service. It exercises the clock, the renderer and the cursor, which
is the part that has to feel right before anything else matters.

### Spotify

Requires a **Premium** account (Web Playback SDK won't stream on free).

1. Create an app at https://developer.spotify.com/dashboard
2. Redirect URI: `http://127.0.0.1:3000/callback` (Spotify no longer accepts `localhost`)
3. Put the client ID in `.env.local`

Auth is PKCE, entirely client-side — no client secret, nothing to leak.

### Analyzer (optional, for transcription)

```bash
cd analyzer
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

CPU works but Demucs will take several minutes per track. A GPU takes it to seconds.

---

## Layout

```
lib/clock.ts             ★ drift-corrected playback clock — the heart of it
lib/sync-engine.ts       ★ alphaTab external-media bridge + the three loops
lib/types.ts               JammerChart format, TickMap, sync points
lib/transport.ts           the interface every playback source implements
lib/transports/            spotify (Web Playback SDK) · local (<audio>)
lib/spotify-auth.ts        PKCE, no client secret
lib/spotify-api.ts         only the endpoints that still exist
lib/lyrics.ts              LRCLIB client + LRC parser
lib/analyzer-client.ts     job submit/poll, result → JammerChart
lib/fretboard.ts           chord voicings, tick→ms for the highway
lib/sync-points.ts         alignment maths + validation (pure, tested)
lib/chart-store.ts         persistence, export/import
hooks/useSpotifyPlayer.ts  SDK loading and its four failure modes
components/FretboardHighway.tsx ★ the scrolling Guitar-Hero fretboard (canvas)
components/ChordPanel.tsx     now/next chord diagrams
components/SyncEditor.tsx     nudge / two-point / tap alignment
components/JamWorkspace.tsx   view switcher, shared by both jam pages
components/TabView.tsx        alphaTab in external-media mode
components/Transport.tsx      scrub bar, song facts (60fps via refs, not state)
components/LyricsView.tsx     synced / unsynced / instrumental
components/LatencyCalibrator.tsx   ← do not skip this
analyzer/pipeline.py       Demucs → beats → key → chords → pitch → frets
analyzer/main.py           FastAPI, queued jobs
app/dev/highway            visual harness for tuning the highway
test/                      clock simulation, chart/lyrics, fretboard
```

## The fretboard highway

A scrolling 3D fretboard: notes approach a hit line, one lane per string, the fret
number inside each note.

Unlike Guitar Hero's five arbitrary lanes, **a lane is a string** — so the display is a
literal instruction ("this string, that fret, now") and what you learn reading it
transfers to the actual instrument. Beat lines cross the board so you can feel the
tempo and see the bar coming; held notes get a sustain tail; struck notes flash.

It's drawn on canvas, not DOM, and reads the clock directly on `requestAnimationFrame`
without touching React state. At 60fps with a few hundred visible notes, DOM nodes with
CSS transforms drop frames — and this is the one view where a dropped frame is *felt*.

`/dev/highway` drives it from a synthetic riff with no audio, for tuning the
perspective and lead time without loading a song.

## Aligning a chart to a recording

The Align tool is how one chart comes to fit many recordings. Three modes, ordered by
effort — most songs need only the first:

1. **Nudge** — one offset for the whole song. Fixes a different lead-in. Seconds.
2. **Two-point** — offset plus stretch. Fixes a different master or sample rate.
3. **Tap** — hit `T` on each downbeat. Tracks a live performance that drifts.

There's no waveform to drag markers onto, and there can't be: DRM means there are no
samples to draw. Tapping works identically on every transport, and you're aligning to
what you *hear* rather than to what the peaks look like.

## Tests

```bash
npm test                      # 31 tests: clock sim, TickMap, LRC, voicings, alignment
cd analyzer && python3 test_pipeline.py   # 37 checks: fretting, beats, chords
```

The clock is tested by simulation rather than by eye, because its failure mode is
subtle: a cursor 2ms jerky or 80ms late still "works", it just feels wrong — and feeling
wrong is the one thing this app can't afford. The suite asserts a max per-frame
deviation under 1ms against a transport that reports coarsely, late and irregularly.

---

## Calibrate your latency

Seriously. Bluetooth headphones add 150–300 ms between the cursor and what you hear. Left
uncalibrated, Jammer feels broken and players assume their own timing is off. The
calibrator is three taps and it's the difference between a toy and a tool.

---

## Status

Built and verified (`npx next build` is clean; both suites pass):

- [x] Playback clock with PLL drift correction — simulated, <1ms per-frame deviation
- [x] alphaTab external-media bridge
- [x] Transport interface + Spotify and local-file implementations
- [x] Spotify PKCE auth, library, search
- [x] Latency calibrator
- [x] LRCLIB lyrics with a parser that survives real-world LRC
- [x] Analyzer pipeline and service (beats, key, chords, notes, fretting)
- [x] Fretboard highway, verified by screenshot
- [x] Chord diagrams — now/next, with voicings
- [x] Sync-point editor (nudge / two-point / tap) with validation
- [x] Persistence for charts and alignments, with JSON export/import

Not done:

- [ ] Drum tab from the drums stem
- [ ] Loop a section / count-in / mute-a-stem
- [ ] YouTube transport
- [ ] Server-side persistence — charts live in localStorage, which is one
      "clear site data" away from gone. Export regularly until this lands.
- [ ] Note-level editing (you can fix the alignment, not yet fix a wrong fret)

Two caveats worth knowing before you run it:

1. **The analyzer's dependencies are heavy and madmom is awkward.** It needs a source
   build and hasn't kept up with modern numpy. The pipeline falls back to librosa
   automatically — you get beats but no downbeats, and a correspondingly lower
   confidence. `beat-this` or `allin1` are the better modern choices.
2. **Nothing has been run against a live Spotify Premium session.** The auth flow,
   SDK wiring and API calls are written against current docs, but the first real
   connection will find something.

Build order and rationale are in `ARCHITECTURE.md`.
