"""Test the pure-numpy parts of the pipeline: fret assignment, key templates, merging."""
import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))

from pipeline import (
    Note, Chord, BeatGrid, Beat, PPQ,
    assign_frets, STANDARD_GUITAR, STANDARD_BASS,
    _merge_repeats, _enforce_monophony, _median_bpm, _beat_confidence,
    _number_bars, _ms_to_tick,
    KRUMHANSL_MAJOR, KRUMHANSL_MINOR, PITCH_NAMES,
)
import numpy as np

fails = 0
def check(name, cond, detail=""):
    global fails
    if cond:
        print(f"  ok   {name}")
    else:
        fails += 1
        print(f"  FAIL {name} {detail}")


print("assign_frets")

# An open E minor pentatonic run — should prefer open strings and low frets.
riff = [Note(tick=i * PPQ // 2, duration_ticks=PPQ // 2, midi=m)
        for i, m in enumerate([40, 43, 45, 47, 50, 52])]
out = assign_frets(riff, STANDARD_GUITAR)
check("all notes assigned", all(n.string is not None and n.fret is not None for n in out))
check("frets in range", all(0 <= n.fret <= 22 for n in out))
check("pitch is preserved",
      all(STANDARD_GUITAR[n.string] + n.fret == n.midi for n in out),
      [(n.midi, n.string, n.fret) for n in out])
check("prefers low positions for an open-position riff",
      max(n.fret for n in out) <= 5,
      [n.fret for n in out])

# A high melody: should pick a consistent position rather than leaping around.
high = [Note(tick=i * PPQ // 4, duration_ticks=PPQ // 4, midi=m)
        for i, m in enumerate([72, 74, 76, 77, 79, 77, 76, 74])]
out2 = assign_frets(high, STANDARD_GUITAR)
spread = max(n.fret for n in out2) - min(n.fret for n in out2)
check("keeps the hand in one position", spread <= 7, f"fret spread {spread}")
check("high melody pitch preserved",
      all(STANDARD_GUITAR[n.string] + n.fret == n.midi for n in out2))

# Bass: 4 strings, should still resolve.
bass = [Note(tick=i * PPQ, duration_ticks=PPQ, midi=m)
        for i, m in enumerate([28, 33, 35, 40, 43])]
out3 = assign_frets(bass, STANDARD_BASS)
check("bass pitch preserved",
      all(STANDARD_BASS[n.string] + n.fret == n.midi for n in out3),
      [(n.midi, n.string, n.fret) for n in out3])
check("open low E is an open string", out3[0].fret == 0 and out3[0].string == 0)

# Out-of-range note must be clamped, never dropped.
impossible = [Note(tick=0, duration_ticks=PPQ, midi=20)]  # below a guitar's range
out4 = assign_frets(impossible, STANDARD_GUITAR)
check("out-of-range note kept, not dropped", len(out4) == 1 and out4[0].fret is not None)

check("empty input is safe", assign_frets([], STANDARD_GUITAR) == [])


print("\n_merge_repeats")
chords = [
    Chord(tick=0, duration_ticks=PPQ, symbol="C", root=0, confidence=0.8),
    Chord(tick=PPQ, duration_ticks=PPQ, symbol="C", root=0, confidence=0.9),
    Chord(tick=2*PPQ, duration_ticks=PPQ, symbol="G", root=7, confidence=0.7),
    Chord(tick=3*PPQ, duration_ticks=PPQ, symbol="C", root=0, confidence=0.6),
]
merged = _merge_repeats(chords)
check("merges consecutive duplicates", len(merged) == 3, len(merged))
check("held chord gets summed duration", merged[0].duration_ticks == 2 * PPQ)
check("keeps max confidence", merged[0].confidence == 0.9)
check("does not merge across a change", merged[2].symbol == "C")
check("empty is safe", _merge_repeats([]) == [])


print("\n_enforce_monophony")
overlapping = [
    Note(tick=0, duration_ticks=PPQ * 2, midi=40, velocity=100),
    Note(tick=PPQ, duration_ticks=PPQ, midi=52, velocity=40),   # quiet octave ghost
    Note(tick=PPQ * 2, duration_ticks=PPQ, midi=45, velocity=90),
]
mono = _enforce_monophony(overlapping)
check("drops the quiet overlapping ghost", len(mono) == 2, [n.midi for n in mono])
check("keeps the loud notes", {n.midi for n in mono} == {40, 45})

louder_overlap = [
    Note(tick=0, duration_ticks=PPQ * 2, midi=40, velocity=50),
    Note(tick=PPQ, duration_ticks=PPQ, midi=52, velocity=110),
]
mono2 = _enforce_monophony(louder_overlap)
check("truncates the earlier note when the later is louder",
      len(mono2) == 2 and mono2[0].duration_ticks == PPQ,
      [(n.midi, n.duration_ticks) for n in mono2])


print("\nbeat grid helpers")
beats = [Beat(media_ms=i * 500.0, beat_in_bar=(i % 4) + 1, bar=0) for i in range(16)]
_number_bars(beats)
check("bars numbered from 1", beats[0].bar == 1)
check("bar increments on downbeat", beats[4].bar == 2 and beats[8].bar == 3)
check("120bpm from 500ms beats", abs(_median_bpm(beats) - 120.0) < 1e-6)
check("steady grid is confident", _beat_confidence(beats) > 0.95)

jittery = [Beat(media_ms=i * 500.0 + (137 * i % 200), beat_in_bar=(i % 4) + 1, bar=1)
           for i in range(16)]
check("erratic grid is not confident", _beat_confidence(jittery) < 0.7,
      _beat_confidence(jittery))
check("too few beats -> zero confidence", _beat_confidence(beats[:2]) == 0.0)
check("empty grid bpm falls back", _median_bpm([]) == 120.0)


print("\n_ms_to_tick")
grid = BeatGrid(beats=beats, nominal_bpm=120.0)
check("beat 0 -> tick 0", _ms_to_tick(0.0, grid) == 0)
check("beat 4 -> 4 * PPQ", _ms_to_tick(2000.0, grid) == 4 * PPQ, _ms_to_tick(2000.0, grid))
check("half a beat interpolates", _ms_to_tick(250.0, grid) == PPQ // 2)
check("before start clamps to 0", _ms_to_tick(-100.0, grid) == 0)
check("no beats falls back to tempo",
      _ms_to_tick(500.0, BeatGrid(beats=[], nominal_bpm=120.0)) == PPQ)


print("\nkey templates")
check("major profile has 12 bins", len(KRUMHANSL_MAJOR) == 12)
check("minor profile has 12 bins", len(KRUMHANSL_MINOR) == 12)
check("tonic is the strongest bin in major", int(np.argmax(KRUMHANSL_MAJOR)) == 0)
check("tonic is the strongest bin in minor", int(np.argmax(KRUMHANSL_MINOR)) == 0)
# A pure C-major chroma should correlate best with C major.
c_major = np.zeros(12); c_major[[0, 4, 7]] = 1.0
best = max(range(12), key=lambda t: np.corrcoef(np.roll(c_major, -t), KRUMHANSL_MAJOR)[0, 1])
check("C major triad reads as C major", best == 0, PITCH_NAMES[best])

print("\nPASS" if fails == 0 else f"\n{fails} FAILURES")
sys.exit(0 if fails == 0 else 1)
