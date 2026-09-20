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

**On YouTube Music?** Go to `/youtube` and paste a link. In the YT Music app:
Share → Copy link. A YouTube Music link and a YouTube link carry the same video ID, so
this needs no sign-in, no API key and no quota. It's also the only transport that can
**slow the track down** — Spotify's SDK has no playback-rate control at all.

**Try the local-file mode** (`/jam/local`) — drag in an MP3. No auth, no Spotify
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
lib/transports/            spotify (Web Playback SDK) · youtube (IFrame) · local
lib/youtube.ts             URL parsing, Data API search, title heuristics
lib/youtube-library.ts     signed-in playlists and liked music
lib/chord-sheet.ts         chord-sheet parser (chords-above + ChordPro)
lib/chord-chart.ts         timed chords -> a synced JammerChart
lib/google-auth.ts         Google PKCE (token exchange is server-side — see below)
lib/loop.ts                loop regions, bar snapping
lib/transpose.ts           tuning/capo re-fretting, chord transposition
lib/pitch-shift.ts         phase vocoder with identity phase locking
lib/spotify-auth.ts        PKCE, no client secret
lib/spotify-api.ts         only the endpoints that still exist
lib/lyrics.ts              LRCLIB client + LRC parser
lib/analyzer-client.ts     job submit/poll, result → JammerChart
lib/fretboard.ts           chord voicings, tick→ms for the highway
lib/sync-points.ts         alignment maths + validation (pure, tested)
lib/chart-store.ts         persistence, export/import
hooks/useSpotifyPlayer.ts  SDK loading and its four failure modes
hooks/useYouTubePlayer.ts  IFrame API loading, player lifecycle
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
app/api/youtube/token      server-side OAuth exchange (Google requires a secret)
app/dev/highway            visual harness for tuning the highway
app/dev/import             visual harness for the chord-sheet importer
test/                      clock simulation, chart/lyrics, fretboard
```

## YouTube / YouTube Music

There is **no official YouTube Music API**. What works, and what doesn't:

| | Status |
|---|---|
| Play any track | ✅ IFrame Player API — official, free, no Premium |
| Slow down / speed up | ✅ 0.25×–2×. **Spotify cannot do this at all** |
| Search | ✅ Data API v3. Needs a free key. ~100 searches/day on the free quota |
| Your YTM playlists | ✅ Sign in with Google — they're backed by YouTube playlists |
| Your liked songs | ✅ via liked videos (see below) |
| The `LM` "Liked Music" playlist itself | ❌ No official API exposes it — we fall back to liked videos, which overlap heavily, and say which one you're seeing |
| YTM uploads | ❌ Not exposed |

**Paste-a-link is the primary path**, not a fallback: it needs no auth and no quota,
and it's more reliable than anything built on an API. `ytmusicapi` can reach the rest
by replaying web-client requests with your cookies — fine for a personal script, but it
breaks without warning. If you want your Liked Music here, copy it into a normal
playlist, which the official API can see.

Two things to expect: official music videos from major labels often **block embedding**
(error 101/150) — look for the "Artist - Topic" upload, which is the YouTube Music
audio track and is almost always embeddable. And the player stays visible, because
YouTube's terms require it.

## Practice tools

**Loop a section.** `A` sets the loop start at the playhead, `B` the end, `L` toggles.
Both snap to the nearest downbeat when there's a beat grid — a loop set by eye clips the
downbeat and lands differently every repetition; snapped, it's the same eight bars every
time. Arrows move the loop a whole section at a time ("now the next eight").

**Slow down.** YouTube and local files only; Spotify's SDK has no rate control.

**Transpose** — and here there are two different operations that get confused:

| | What changes | Matches the recording? | Works on |
|---|---|---|---|
| Tuning / capo | Where your fingers go | ✅ Yes | Every transport |
| Audio pitch | The actual sound | ✅ Yes | **Local files only** |

Streamed audio is DRM-protected, so there are no samples to pitch-shift. But for the
most common real case — a song recorded a half step down, which covers a huge amount of
rock — the *fingering* transform is the better answer anyway: tune to Eb, Jammer
re-frets the chart, and you play familiar shapes that sound right against the untouched
recording. Nothing is degraded by resampling.

For local files, `lib/pitch-shift.ts` is a real phase vocoder: FFT, per-bin true
frequency from phase advance, and **identity phase locking** so spectral peaks stay
coherent. Without the locking pass, a stretched sine came out 18 dB down while still
reporting the right pitch — the partials in adjacent bins drift apart and cancel. It's
tested against synthetic tones: +12 semitones must double the frequency and leave the
duration alone.

## Getting chords for a song

There is **no legitimate API for chords or tabs.** Ultimate Guitar has none (only
scrapers). Chordify has none — there's a support-forum post asking for one. Hooktheory
returns aggregate statistics, not per-song lookups. Every chord site either analyses
audio itself or is human-transcribed behind a login.

So Jammer does the two halves it legitimately can:

1. **Find chords** — the jam page links straight to pre-searched results for whatever
   is playing, on Ultimate Guitar, Songsterr, e-chords and Chordie. One tap, right song.
2. **Sync them** — copy the sheet, paste it into Jammer, tap once through the song on
   each chord change. Now it's on the highway, saved, and auto-matched to every other
   version of that song forever.

Jammer never fetches from those sites itself. Their catalogues are licensed from
publishers and their terms forbid automated access; a scraper is a liability for
whoever hosts it and breaks every few weeks besides. You copying a page you're already
reading is a different act entirely.

The parser handles both the chords-above-lyrics layout the web uses and ChordPro
brackets, picks up capo/key/tuning headers, and skips bar lines and repeat marks. Its
heuristics deliberately fail toward *lyrics*: a missed chord is obvious, while a lyric
line silently eaten as chords corrupts the sheet.

**Why tapping rather than guessing the timing:** a chord sheet has no timing at all.
Estimating a tempo and assuming a bar per chord is wrong constantly — intros, half-bar
changes, a chord held under a solo — and a chart that's subtly wrong is worse than
none, because you blame your own playing. One pass, once per song, and you were
listening anyway.

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
npm test                      # 68 tests: clock, TickMap, LRC, voicings, alignment,
                              #           YT links, FFT + phase vocoder, chord sheets
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
- [x] Chord-sheet paste + parser, with tap-to-time and auto-generated strums
- [x] Pre-searched links to the chord and tab sites
- [x] Album and playlist links expand into a track list
- [x] Fretboard highway, verified by screenshot
- [x] Chord diagrams — now/next, with voicings
- [x] Sync-point editor (nudge / two-point / tap) with validation
- [x] Persistence for charts and alignments, with JSON export/import
- [x] YouTube transport — paste-a-link, search, slow-down practice
- [x] YouTube sign-in — your playlists and liked songs
- [x] Section looping with bar snapping
- [x] Tuning / capo re-fretting (every transport)
- [x] Audio pitch shifting via phase vocoder (local files)

Not done:

- [ ] Drum tab from the drums stem
- [ ] Count-in clicks before a loop restarts
- [ ] Mute-a-stem (needs the analyzer's Demucs output plumbed to playback)
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
