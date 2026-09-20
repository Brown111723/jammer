# Jammer — Architecture

## The three constraints that shape everything

Before any code, three facts about this stack. Two of them are recent, and one of them
kills the most obvious version of the product.

### 1. Spotify's audio-intelligence endpoints are gone

On 27 November 2024 Spotify deprecated `GET /v1/audio-features`, `GET /v1/audio-analysis`,
`GET /v1/recommendations` and `GET /v1/artists/{id}/related-artists` **for all apps created
after that date**. New apps get a bare `403`. There is no official replacement.

That was the free source of BPM, key and time signature. It is not available to us.

> **Consequence:** Jammer computes tempo, key and metre itself. This turns out to be a
> feature, not a tax — Spotify's numbers were track-level averages and frequently wrong
> about metre. We produce a full beat grid with downbeats, which is strictly more useful
> for a playhead than a single BPM number.

### 2. You cannot tap the audio of a stream you don't own

Both playback paths deliver DRM-protected audio:

| Path | Transport | Audio reachable from JS? |
|---|---|---|
| Spotify Web Playback SDK | Widevine via Encrypted Media Extensions | **No** |
| YouTube IFrame Player API | Widevine via EME, cross-origin iframe | **No** |

The decrypted samples never enter the page's JavaScript context. There is no
`MediaElementSourceNode`, no `AnalyserNode`, no `captureStream()`. This is the entire point
of EME and it is not a bug to route around.

> **Consequence — the big one:** "play a Spotify track and auto-transcribe it live" is not
> buildable. Transcription must run **ahead of time, server-side, on an audio file the user
> supplies or that we have rights to analyse.** The streaming session only ever tells us
> *where the playhead is*.
>
> This is the single design decision to internalise. Everything below follows from it.

### 3. Tab and lyrics are licensed content

Ultimate Guitar and Songsterr have no public API and their catalogues are licensed from
publishers. Scraping them is both a ToS breach and straightforward infringement. Genius'
API deliberately does not return lyric bodies.

> **Consequence:** chart content comes from (a) our own analysis of audio, (b) Guitar Pro /
> MusicXML files the user imports, or (c) the user's own edits. Lyrics come from
> **LRCLIB** — free, no API key, crowd-sourced, already `[mm:ss.xx]`-timestamped, which is
> exactly the shape we need. Be a good citizen: send a real `User-Agent` and honour `429`.

---

## The design: two planes bound by sync points

The insight that makes Jammer work — and makes it genuinely better than Songsterr rather
than just a clone — is to stop treating "the audio" and "the chart" as one object.

```
  TRANSPORT PLANE                          CHART PLANE
  (licensed, DRM, opaque)                  (ours, open, editable)

  Spotify Web Playback SDK   ─┐        ┌─  Beat grid (downbeats, metre, tempo curve)
  YouTube IFrame Player      ─┤        ├─  Chord track
  Local file / <audio>       ─┤        ├─  Tab: guitar / bass / drums
                              │        ├─  Key + section labels
                              │        └─  Lyrics (LRCLIB, or from vocal stem)
                              │
                              └──── SYNC POINTS ────┘
                                  (position ↔ musical tick)
```

The **transport plane** owns playback. We ask it one question, often: *where are you?*
We never ask it for audio.

The **chart plane** owns musical time, measured in ticks, not seconds.

A small list of **sync points** maps between them. Two points give you offset and linear
stretch; more points track a drifting human performance.

### Why this beats being welded to one audio file

Songsterr plays *its own* synthesised audio, so its chart is always in sync by
construction — and can never be in sync with anything else. Jammer's chart floats free of
any particular recording. One chart for "Black Dog" aligns to the 1971 master, the 2007
remaster, the live version, and the half-speed practice copy — each is just a different
sync-point set on the same chart.

That is the feature. It's also the reason the chart format below stores *ticks*, and why
sync points are a first-class object rather than a single `offsetMs` field.

---

## The playback clock (`lib/clock.ts`)

Naively: poll Spotify for position, move the cursor there. This looks terrible. Here's why,
and what to do instead.

`player.getCurrentState()` returns a position that is:

- **coarse** — it moves in steps, not continuously
- **stale** — it describes when the state was produced, not now
- **jittery** — network and worker scheduling add variable delay
- **not callable at 60 fps** — it's an async IPC round-trip

So we don't drive the cursor from it. We run a **local clock** and use Spotify only to
discipline it — the same structure as a phase-locked loop, or NTP:

```
predicted(t) = anchorMedia + (t − anchorWall) × rate
```

On each observation we compute the error against our prediction, then:

- **|error| > 250 ms** → a seek or track change happened. Hard re-anchor.
- **|error| ≤ 250 ms** → normal drift. Do **not** jump. Trim `rate` by a bounded amount
  (≤ ±2 %) so the error closes smoothly over ~1.5 s. A 2 % rate trim is imperceptible;
  a 40 ms cursor jump is very perceptible.

Then two further offsets are applied before the cursor is placed:

1. **Output latency** — user-calibrated. Bluetooth headphones routinely add **150–300 ms**.
   Untreated, this is fatal for a jamming tool: the player hears the beat a third of a
   second after the cursor shows it, and blames themselves. Ship a tap-along calibrator.
   This is probably the highest-value 50 lines in the project.
2. **Chart offset** — this recording's alignment to the chart, from the sync points.

Render from `clock.now()` on `requestAnimationFrame`. Push to alphaTab every 50 ms.

---

## alphaTab as the renderer

`alphaTab` (1.6+, current 1.8.x) renders Guitar Pro files to tab and notation in the
browser and — critically — added an **External Media** mode built for exactly this:

```ts
settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;

const output = api.player.output as alphaTab.synth.IExternalMediaSynthOutput;
output.handler = { /* backingTrackDuration, playbackRate, masterVolume,
                      seekTo, play, pause */ };

// then, ~every 50 ms:
output.updatePosition(mediaPositionMs);
```

alphaTab handles cursor placement, beat highlighting, bar-level scroll and the
tab/notation rendering. We supply time. This saves months and is the reason the project is
tractable at all.

Note alphaTab plays *either* its synth *or* external media, never mixed. With Spotify as
transport the synth is off, so no click track from alphaTab — build the metronome with Web
Audio separately.

---

## The analyzer pipeline (`analyzer/`)

Runs offline, server-side, on a local audio file. Never on a stream. Python, because every
model in this space is Python.

```
audio.wav
  │
  ├─► Demucs v4 ──────────► stems: drums / bass / vocals / other
  │
  ├─► beat & downbeat ────► beat grid, tempo curve, time signature
  │     (All-In-One, or BeatNet; madmom as fallback)
  │
  ├─► key detection ──────► key + mode (Essentia / madmom)
  │
  ├─► chord recognition ──► timed chord symbols, snapped to the beat grid
  │
  ├─► per-stem pitch ─────► basic-pitch → MIDI notes
  │     bass stem  → monophonic, high accuracy, do this first
  │     other stem → polyphonic guitar, hardest case
  │     drums stem → onset classification → drum tab
  │
  └─► fret assignment ────► MIDI → tablature
        Viterbi over (string, fret) candidates, cost = hand travel +
        stretch + open-string bonus. See Fretting-Transformer (2025)
        for a learned alternative.
```

**Quality order, best to worst:** beat grid → key → bass tab → chords → drums → polyphonic
guitar tab. Ship in that order. Beat-and-chords alone is already a useful jamming tool;
note-perfect polyphonic guitar transcription is still an open research problem in 2026 and
you should not gate v1 on it.

Always treat output as a **draft the user edits**, and persist the edits. A chart that
improves every time someone corrects it is worth more than a marginally better model.

---

## Stack

| Layer | Choice | Note |
|---|---|---|
| Web | Next.js 15 + React 19 + TS | app router |
| Notation | alphaTab 1.8 | external media mode |
| Transport | Spotify Web Playback SDK | **Premium required** |
| Transport | YouTube IFrame API | free, but video not "YouTube Music" |
| Lyrics | LRCLIB | free, no key, honour rate limits |
| Analyzer | FastAPI + PyTorch | GPU strongly preferred |
| Jobs | Redis + RQ | Demucs is minutes, not seconds |
| Store | Postgres + S3 | charts as JSON |

### On YouTube Music specifically

There is **no official YouTube Music API**. `ytmusicapi` works by replaying web-client
requests with your cookies — fine for a personal script, but it is unofficial, breaks
without warning, and is not a defensible base for a public product.

The supported path is the **YouTube IFrame Player API**, which plays regular YouTube
videos in an embedded player you must keep visible (≥200×200, per YouTube's terms).

The detail that makes this work well: **a YouTube Music track and its YouTube video
share the same 11-character video ID.** So `Share → Copy link` in the YouTube Music app
produces a URL Jammer can play directly — no auth, no API key, no quota. Paste-a-link is
the primary entry point, with Data API v3 search as a secondary path.

YouTube is arguably the *better* transport for this app despite being the "free" one:
`setPlaybackRate` gives 0.25×–2×, and practising a passage at 70% speed is the feature
guitarists ask for first. Spotify's SDK cannot change rate at all.

What's still out of reach: "Liked Music" (`LM`) is a YouTube Music auto-playlist that no
official API exposes, and neither are YTM uploads. User-created YTM playlists *are*
ordinary YouTube playlists, so OAuth + `playlists.list(mine=true)` reaches those.

---

## Build order

1. **Clock + alphaTab + a local MP3.** No auth, no cloud. Prove the cursor feels right.
   If this stage isn't satisfying, nothing downstream saves it.
2. **Latency calibrator.** Do it early; you'll need it to judge step 1 honestly.
3. **Spotify auth + Web Playback SDK.** Swap the `<audio>` transport for Spotify. The
   clock should be the only thing that changes.
4. **Analyzer: beat grid + key + chords.** Chords-over-a-beat-grid is a shippable product.
5. **Sync-point editor.** Two-point align, tap-to-add. Unlocks the multi-master feature.
6. **Bass tab, then drums, then guitar.**
7. **Practice tools.** Loop a section, slow down (Spotify can't change rate — this is
   where a local file or YouTube's `setPlaybackRate` wins), count-in, mute-the-stem.

## Legal posture

Do the boring thing properly and this is a clean product:

- Stream only through licensed SDKs. Never proxy, cache or download stream audio.
- Users analyse audio **they own**. Don't build a URL-to-audio ripper — that's the line
  most tools in this space cross.
- Charts are user-generated; you host them. Have a DMCA path.
- Lyrics via LRCLIB, attributed, rate-limited, with a takedown route.
- Don't scrape Ultimate Guitar or Songsterr. Do offer Guitar Pro import.
