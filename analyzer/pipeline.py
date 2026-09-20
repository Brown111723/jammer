"""
The transcription pipeline.

STRUCTURE
---------
Every stage is optional and degrades independently. That matters because the stages have
wildly different reliability, and a pipeline that fails whole-hog when the hardest stage
fails would throw away the easy wins.

Reliability, best to worst:

    beat grid   ~95% on 4/4 pop/rock with a clear backbeat
    key         ~85% globally, much worse on modal or chromatic material
    bass tab    ~80% note accuracy after separation (monophonic — the easy case)
    chords      ~75% on majors/minors, drops sharply on extensions and inversions
    drums       ~70% for kick/snare/hat, poor for toms and cymbal types
    guitar tab  ~50% polyphonic note accuracy — an open research problem

So: ship beats and chords first. They are useful on their own, and "chords over a beat
grid with a moving playhead" is already a better jamming tool than most of what exists.
Do not gate v1 on polyphonic guitar transcription.

Everything here returns a confidence, and the UI is expected to show low-confidence
output as provisional rather than asserting it. A wrong chord stated confidently is
worse than a chord marked uncertain.

DEPENDENCIES
------------
Heavy and slow to install. Each is imported lazily inside its stage so that a partial
install still runs the stages it can.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Literal

import numpy as np

log = logging.getLogger("jammer.pipeline")

PPQ = 960
SAMPLE_RATE = 44100

StemName = Literal["drums", "bass", "vocals", "other"]


# ---------------------------------------------------------------- results


@dataclass
class Beat:
    media_ms: float
    beat_in_bar: int
    bar: int
    confidence: float = 1.0


@dataclass
class BeatGrid:
    beats: list[Beat] = field(default_factory=list)
    nominal_bpm: float = 120.0
    time_signature: tuple[int, int] = (4, 4)
    confidence: float = 0.0


@dataclass
class Key:
    tonic: int  # 0 = C
    mode: str  # "major" | "minor"
    confidence: float = 0.0


@dataclass
class Chord:
    tick: int
    duration_ticks: int
    symbol: str
    root: int | None
    quality: str = ""
    confidence: float = 0.0


@dataclass
class Note:
    tick: int
    duration_ticks: int
    midi: int
    velocity: int = 90
    string: int | None = None
    fret: int | None = None


@dataclass
class AnalysisResult:
    duration_ms: float
    beat_grid: BeatGrid
    key: Key | None
    chords: list[Chord]
    tracks: dict[str, list[Note]]
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "durationMs": self.duration_ms,
            "beatGrid": {
                "beats": [
                    {
                        "mediaMs": b.media_ms,
                        "beatInBar": b.beat_in_bar,
                        "bar": b.bar,
                        "confidence": b.confidence,
                    }
                    for b in self.beat_grid.beats
                ],
                "nominalBpm": self.beat_grid.nominal_bpm,
            },
            "timeSignature": {
                "numerator": self.beat_grid.time_signature[0],
                "denominator": self.beat_grid.time_signature[1],
            },
            "key": asdict(self.key) if self.key else None,
            "chords": [asdict(c) for c in self.chords],
            "tracks": {
                name: [asdict(n) for n in notes] for name, notes in self.tracks.items()
            },
            "confidence": {
                "beats": self.beat_grid.confidence,
                "key": self.key.confidence if self.key else 0.0,
                "chords": (
                    float(np.mean([c.confidence for c in self.chords]))
                    if self.chords
                    else 0.0
                ),
            },
            "warnings": self.warnings,
        }


# ---------------------------------------------------------------- audio io


def load_audio(path: Path, sr: int = SAMPLE_RATE) -> tuple[np.ndarray, int]:
    """Mono float32 at `sr`."""
    import librosa

    y, actual_sr = librosa.load(str(path), sr=sr, mono=True)
    return y.astype(np.float32), actual_sr


# ---------------------------------------------------------------- stems


def separate_stems(path: Path, out_dir: Path) -> dict[StemName, Path]:
    """
    Demucs v4 (htdemucs). Separation is what makes everything downstream tractable:
    pitch tracking on a mixed rock track is hopeless, on an isolated bass stem it's
    nearly solved.

    This is by far the slowest stage. Minutes on CPU, seconds on GPU.
    """
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.eval()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        log.warning("No GPU — Demucs will take several minutes per track.")
    model.to(device)

    y, sr = load_audio(path, sr=model.samplerate)
    # Demucs wants (batch, channels, samples) stereo.
    wav = torch.tensor(np.stack([y, y]), dtype=torch.float32).unsqueeze(0).to(device)

    with torch.no_grad():
        sources = apply_model(model, wav, device=device, progress=False)[0]

    out_dir.mkdir(parents=True, exist_ok=True)
    stems: dict[StemName, Path] = {}

    import soundfile as sf

    for name, source in zip(model.sources, sources):
        dest = out_dir / f"{name}.wav"
        sf.write(str(dest), source.cpu().numpy().T, model.samplerate)
        stems[name] = dest  # type: ignore[index]

    return stems


# ---------------------------------------------------------------- beats


def detect_beats(path: Path) -> BeatGrid:
    """
    Beat, downbeat and metre.

    Tries madmom's RNN + DBN first — still the strongest classical approach and it
    gives downbeats and metre, not just beats. Falls back to librosa, which gives beats
    only, and then we have to guess the metre (assume 4/4 and say so in a warning).

    Downbeats are the part that matters. Beats alone give you a click track; downbeats
    give you bars, which is what a tab cursor needs to scroll by.
    """
    try:
        return _beats_madmom(path)
    except Exception as exc:  # noqa: BLE001
        log.warning("madmom unavailable or failed (%s); falling back to librosa", exc)
        return _beats_librosa(path)


def _beats_madmom(path: Path) -> BeatGrid:
    from madmom.features.downbeats import (
        DBNDownBeatTrackingProcessor,
        RNNDownBeatProcessor,
    )

    # Test 3/4 and 4/4. Adding 5/4 and 7/8 helps prog but costs accuracy elsewhere —
    # better to expose metre as a user override than to over-search here.
    processor = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=100)
    activations = RNNDownBeatProcessor()(str(path))
    result = processor(activations)  # (time_seconds, beat_in_bar)

    beats = [
        Beat(media_ms=float(t) * 1000.0, beat_in_bar=int(b), bar=0)
        for t, b in result
    ]
    _number_bars(beats)

    numerator = int(max((b.beat_in_bar for b in beats), default=4))
    grid = BeatGrid(
        beats=beats,
        nominal_bpm=_median_bpm(beats),
        time_signature=(numerator, 4),
        confidence=_beat_confidence(beats),
    )
    return grid


def _beats_librosa(path: Path) -> BeatGrid:
    import librosa

    y, sr = load_audio(path)
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    times = librosa.frames_to_time(frames, sr=sr)

    beats = [
        Beat(media_ms=float(t) * 1000.0, beat_in_bar=(i % 4) + 1, bar=0, confidence=0.5)
        for i, t in enumerate(times)
    ]
    _number_bars(beats)

    return BeatGrid(
        beats=beats,
        nominal_bpm=float(np.atleast_1d(tempo)[0]),
        time_signature=(4, 4),
        # Librosa gives no downbeats — bar 1 is a guess. Say so honestly.
        confidence=0.4,
    )


def _number_bars(beats: list[Beat]) -> None:
    bar = 0
    for b in beats:
        if b.beat_in_bar == 1:
            bar += 1
        b.bar = max(1, bar)


def _median_bpm(beats: list[Beat]) -> float:
    if len(beats) < 2:
        return 120.0
    deltas = np.diff([b.media_ms for b in beats])
    deltas = deltas[deltas > 0]
    if len(deltas) == 0:
        return 120.0
    return float(60_000.0 / np.median(deltas))


def _beat_confidence(beats: list[Beat]) -> float:
    """
    Steadiness of the inter-beat interval, as a proxy for tracker confidence.
    A tracker that has locked on produces very regular intervals; one that is guessing
    produces erratic ones. Genuine rubato will score low here too — which is correct,
    because a drifting grid IS less certain.
    """
    if len(beats) < 4:
        return 0.0
    deltas = np.diff([b.media_ms for b in beats])
    deltas = deltas[deltas > 0]
    if len(deltas) < 3:
        return 0.0
    cv = float(np.std(deltas) / np.mean(deltas))
    return float(np.clip(1.0 - cv * 4.0, 0.0, 1.0))


# ---------------------------------------------------------------- key


KRUMHANSL_MAJOR = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
KRUMHANSL_MINOR = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)


def detect_key(path: Path) -> Key:
    """
    Krumhansl-Schmuckler key finding on a chroma profile.

    Simple, fast, no model download, and roughly as good as anything else on tonal
    popular music. It fails on modal material (a Dorian tune reads as its relative
    major) and on anything chromatic — hence the confidence value, which is the margin
    between the best and second-best correlation. A narrow margin means "this is
    ambiguous", and the UI should say so rather than pick one.
    """
    import librosa

    y, sr = load_audio(path)
    # CQT chroma is more robust than STFT chroma for this.
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    profile = chroma.mean(axis=1)
    profile = profile / (profile.sum() + 1e-9)

    scores: list[tuple[float, int, str]] = []
    for tonic in range(12):
        rotated = np.roll(profile, -tonic)
        scores.append((float(np.corrcoef(rotated, KRUMHANSL_MAJOR)[0, 1]), tonic, "major"))
        scores.append((float(np.corrcoef(rotated, KRUMHANSL_MINOR)[0, 1]), tonic, "minor"))

    scores.sort(reverse=True)
    best, tonic, mode = scores[0]
    runner_up = scores[1][0]

    # Margin -> confidence. Correlations cluster tightly, so scale generously.
    margin = max(0.0, best - runner_up)
    confidence = float(np.clip(margin * 6.0, 0.0, 1.0))

    return Key(tonic=tonic, mode=mode, confidence=confidence)


# ---------------------------------------------------------------- chords


CHORD_TEMPLATES: dict[str, list[int]] = {
    "": [0, 4, 7],          # major
    "m": [0, 3, 7],
    "7": [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11],
    "m7": [0, 3, 7, 10],
    "sus4": [0, 5, 7],
    "sus2": [0, 2, 7],
    "dim": [0, 3, 6],
    "aug": [0, 4, 8],
    "5": [0, 7],            # power chord — essential for rock, often missed
}

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def detect_chords(path: Path, grid: BeatGrid) -> list[Chord]:
    """
    Template-matching chord recognition, segmented by the beat grid.

    Snapping segments to beats rather than using fixed windows is the single biggest
    quality win available here: chords change on beats, so beat-synchronous chroma
    averaging both denoises the chroma and puts the boundaries where they belong.

    A trained model (BTC, or the Axial-RoFormer + semi-CRF approaches from 2024-2026)
    will beat this by a wide margin on extensions and inversions. This gets you
    majors, minors, sevenths and power chords, which covers most of what a person
    strumming along actually needs.
    """
    import librosa

    if len(grid.beats) < 2:
        return []

    y, sr = load_audio(path)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    times = librosa.times_like(chroma, sr=sr)

    beat_times = np.array([b.media_ms / 1000.0 for b in grid.beats])
    ticks_per_beat = PPQ  # assumes quarter-note beats

    chords: list[Chord] = []
    for i in range(len(beat_times) - 1):
        start, end = beat_times[i], beat_times[i + 1]
        mask = (times >= start) & (times < end)
        if not mask.any():
            continue

        segment = chroma[:, mask].mean(axis=1)
        norm = np.linalg.norm(segment)
        if norm < 1e-6:
            continue
        segment = segment / norm

        best_score = -np.inf
        best_root = 0
        best_quality = ""

        for root in range(12):
            for quality, intervals in CHORD_TEMPLATES.items():
                template = np.zeros(12)
                for interval in intervals:
                    template[(root + interval) % 12] = 1.0
                template /= np.linalg.norm(template)
                score = float(segment @ template)
                if score > best_score:
                    best_score, best_root, best_quality = score, root, quality

        chords.append(
            Chord(
                tick=i * ticks_per_beat,
                duration_ticks=ticks_per_beat,
                symbol=f"{PITCH_NAMES[best_root]}{best_quality}",
                root=best_root,
                quality=best_quality,
                # Cosine similarity against a binary template runs ~0.5-0.9; rescale.
                confidence=float(np.clip((best_score - 0.4) / 0.5, 0.0, 1.0)),
            )
        )

    return _merge_repeats(chords)


def _merge_repeats(chords: list[Chord]) -> list[Chord]:
    """Collapse consecutive identical chords into held ones."""
    if not chords:
        return []
    merged = [chords[0]]
    for c in chords[1:]:
        last = merged[-1]
        if c.symbol == last.symbol:
            last.duration_ticks += c.duration_ticks
            last.confidence = max(last.confidence, c.confidence)
        else:
            merged.append(c)
    return merged


# ---------------------------------------------------------------- pitch -> notes


def transcribe_notes(stem_path: Path, grid: BeatGrid, monophonic: bool) -> list[Note]:
    """
    basic-pitch (Spotify's, ironically) for polyphonic note transcription.

    On an isolated bass stem this is genuinely good. On an isolated guitar stem it is
    passable for single-note lines and unreliable for strummed chords — which is the
    honest state of the art, not a limitation of this particular wiring.
    """
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    _, _, note_events = predict(
        str(stem_path),
        model_or_model_path=ICASSP_2022_MODEL_PATH,
        onset_threshold=0.5,
        frame_threshold=0.3,
        # A bass line has no notes below ~30ms; filtering short blips cuts false
        # positives a lot.
        minimum_note_length=80 if monophonic else 50,
    )

    notes = [
        Note(
            tick=_ms_to_tick(start * 1000.0, grid),
            duration_ticks=max(1, _ms_to_tick((end - start) * 1000.0, grid, relative=True)),
            midi=int(pitch),
            velocity=int(np.clip(amplitude * 127, 1, 127)),
        )
        for start, end, pitch, amplitude, *_ in note_events
    ]

    if monophonic:
        notes = _enforce_monophony(notes)

    return sorted(notes, key=lambda n: n.tick)


def _enforce_monophony(notes: list[Note]) -> list[Note]:
    """
    A bass plays one note at a time. Overlaps are transcription errors — usually an
    octave ghost. Keep the loudest note in each overlap and truncate the rest.
    """
    notes = sorted(notes, key=lambda n: (n.tick, -n.velocity))
    kept: list[Note] = []
    for note in notes:
        if kept and note.tick < kept[-1].tick + kept[-1].duration_ticks:
            prev = kept[-1]
            if note.velocity > prev.velocity:
                prev.duration_ticks = max(1, note.tick - prev.tick)
                kept.append(note)
            # else: drop the quieter overlapping note
        else:
            kept.append(note)
    return kept


def _ms_to_tick(ms: float, grid: BeatGrid, relative: bool = False) -> int:
    """Map recording time to ticks through the beat grid, so ticks follow tempo drift."""
    if not grid.beats:
        return int(ms / (60_000.0 / grid.nominal_bpm) * PPQ)

    if relative:
        return int(ms / (60_000.0 / grid.nominal_bpm) * PPQ)

    times = np.array([b.media_ms for b in grid.beats])
    idx = int(np.searchsorted(times, ms))
    if idx <= 0:
        return 0
    if idx >= len(times):
        idx = len(times) - 1

    prev_t, next_t = times[idx - 1], times[idx]
    frac = (ms - prev_t) / (next_t - prev_t) if next_t > prev_t else 0.0
    return int(((idx - 1) + frac) * PPQ)


# ---------------------------------------------------------------- fretting


STANDARD_GUITAR = [40, 45, 50, 55, 59, 64]  # E2 A2 D3 G3 B3 E4
STANDARD_BASS = [28, 33, 38, 43]            # E1 A1 D2 G2


def assign_frets(
    notes: list[Note],
    tuning: list[int],
    max_fret: int = 22,
    open_string_bonus: float = 1.5,
) -> list[Note]:
    """
    MIDI -> (string, fret) by Viterbi over fingering candidates.

    Any given pitch is playable in several places on the neck. The right choice depends
    on what came before: a guitarist keeps their hand still. So this is a shortest-path
    problem, where the cost of a transition is how far the hand must travel.

    Cost terms:
      - hand travel from the previous note's fret (the dominant term)
      - a bonus for open strings, which are free to reach and very common in rock
      - a small penalty for very high frets, which are rarely the intended fingering

    A learned model (Fretting-Transformer, 2025) does better on idiomatic fingerings —
    it knows that a given lick is *usually* played in a particular position. This is a
    sound and fully explainable baseline.
    """
    if not notes:
        return notes

    # Candidate (string, fret) pairs per note.
    candidates: list[list[tuple[int, int]]] = []
    for note in notes:
        options = [
            (s, note.midi - open_midi)
            for s, open_midi in enumerate(tuning)
            if 0 <= note.midi - open_midi <= max_fret
        ]
        # Out of range: clamp to the nearest playable string so we never drop a note.
        if not options:
            closest = min(range(len(tuning)), key=lambda s: abs(note.midi - tuning[s]))
            options = [(closest, max(0, min(max_fret, note.midi - tuning[closest])))]
        candidates.append(options)

    n = len(notes)
    costs = [[0.0] * len(c) for c in candidates]
    back = [[0] * len(c) for c in candidates]

    for j, (_, fret) in enumerate(candidates[0]):
        costs[0][j] = -open_string_bonus if fret == 0 else fret * 0.1

    for i in range(1, n):
        # Notes far apart in time don't constrain each other — the hand has time to move.
        gap = notes[i].tick - notes[i - 1].tick
        travel_weight = 1.0 if gap < PPQ * 2 else 0.25

        for j, (string, fret) in enumerate(candidates[i]):
            local = (-open_string_bonus if fret == 0 else 0.0) + fret * 0.05
            best_cost, best_k = np.inf, 0

            for k, (prev_string, prev_fret) in enumerate(candidates[i - 1]):
                travel = abs(fret - prev_fret) * travel_weight
                # Crossing many strings at once is awkward but much cheaper than
                # sliding the whole hand.
                travel += abs(string - prev_string) * 0.3
                total = costs[i - 1][k] + travel
                if total < best_cost:
                    best_cost, best_k = total, k

            costs[i][j] = best_cost + local
            back[i][j] = best_k

    # Backtrace.
    j = int(np.argmin(costs[-1]))
    path = [j]
    for i in range(n - 1, 0, -1):
        j = back[i][j]
        path.append(j)
    path.reverse()

    for i, choice in enumerate(path):
        notes[i].string, notes[i].fret = candidates[i][choice]

    return notes


# ---------------------------------------------------------------- orchestration


def analyze(
    path: Path,
    work_dir: Path,
    want_stems: bool = True,
    want_tab: bool = True,
) -> AnalysisResult:
    """
    Run the pipeline. Each stage is guarded so a failure degrades the result rather
    than losing the run — three minutes of Demucs is too expensive to throw away
    because chord detection hit an edge case.
    """
    warnings: list[str] = []

    y, sr = load_audio(path)
    duration_ms = len(y) / sr * 1000.0

    grid = detect_beats(path)
    if grid.confidence < 0.5:
        warnings.append(
            "Beat tracking is uncertain — the grid may drift. Check the downbeats "
            "and nudge them in the sync editor if the cursor wanders."
        )

    key: Key | None = None
    try:
        key = detect_key(path)
        if key.confidence < 0.5:
            warnings.append(
                f"Key is ambiguous (best guess {PITCH_NAMES[key.tonic]} {key.mode}). "
                "Modal or chromatic material often reads as its relative major."
            )
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Key detection failed: {exc}")

    chords: list[Chord] = []
    try:
        chords = detect_chords(path, grid)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Chord detection failed: {exc}")

    tracks: dict[str, list[Note]] = {}

    if want_stems and want_tab:
        try:
            stems = separate_stems(path, work_dir / "stems")

            if "bass" in stems:
                bass = transcribe_notes(stems["bass"], grid, monophonic=True)
                tracks["bass"] = assign_frets(bass, STANDARD_BASS)

            if "other" in stems:
                guitar = transcribe_notes(stems["other"], grid, monophonic=False)
                tracks["guitar"] = assign_frets(guitar, STANDARD_GUITAR)
                warnings.append(
                    "Guitar transcription is the least reliable stage — treat it as a "
                    "starting point to edit, not a finished tab."
                )
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Stem separation or transcription failed: {exc}")

    return AnalysisResult(
        duration_ms=duration_ms,
        beat_grid=grid,
        key=key,
        chords=chords,
        tracks=tracks,
        warnings=warnings,
    )
