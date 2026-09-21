# Changelog

The version (package.json) goes up once per delivered iteration. The build number
shown in the app is the git commit count, so it rises with every commit.

## 0.7.0
- Fixed: Guitar Pro files failed with "could not render the score" (alphaTab's
  render worker couldn't load under the bundler, and the file could arrive before
  the renderer existed).
- A Guitar Pro / MusicXML file now drives everything: highway notes for every part
  (bass included), chord panel, tempo changes, sections, beat grid and loops.
  Repeats and 1st/2nd endings are played out in order.
- Tab files are remembered per song (stored in the browser) and load by themselves
  next time the song is opened — on YouTube, Spotify or a local copy.
- The notation cursor follows your Align adjustments, and the notation pane scrolls
  with the song.
- "A (no 3rd)" style chord names are shown as power chords (A5).
- YouTube pages now get the chord-site links and chord-sheet paste too.

## 0.6.0
- Version and build number shown in the home-page footer.
- `scripts/update.sh` and a one-line updater for Termux (see README).

## 0.5.0
- Chord-sheet paste: parses chords-above-lyrics and ChordPro, then tap once through
  the song to sync it. Optional strummed shapes on the highway.
- Pre-searched links to Ultimate Guitar, Songsterr, e-chords and Chordie.
- Album and playlist links expand into a track list.
- More chord shapes (7sus4, 6, m6, 9, add9) with a fallback for unusual chords.

## 0.4.0
- Lyrics load automatically for any pasted link — no API key needed (oEmbed).
- Charts are found by song, not just by recording, so one chart covers every version.

## 0.3.0
- YouTube sign-in: your playlists and liked songs.
- A/B section looping, snapped to the bar.
- Transpose: tuning and capo re-fretting (all sources), audio pitch shift (local files).

## 0.2.0
- YouTube / YouTube Music: paste a link, search, slow-down practice.

## 0.1.0
- First version: playback clock, alphaTab sync, Spotify, local files, fretboard
  highway, chord diagrams, sync editor, latency calibrator, analyzer service.
