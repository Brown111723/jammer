import { test } from "node:test";
import assert from "node:assert/strict";
import {
  voicingFor,
  parseChordSymbol,
  buildHighwayNotes,
  firstNoteAtOrAfter,
  chordsAround,
  STANDARD_GUITAR,
  type HighwayNote,
} from "../lib/fretboard.ts";
import { TickMap, PPQ, type ChartTrack } from "../lib/types.ts";
import { validateSyncPoints, impliedBpmFromTaps, offsetSyncPoints } from "../lib/sync-points.ts";

test("chord symbols parse into root and quality", () => {
  assert.deepEqual(parseChordSymbol("C"), { root: 0, quality: "" });
  assert.deepEqual(parseChordSymbol("F#m7"), { root: 6, quality: "m7" });
  assert.deepEqual(parseChordSymbol("Bb"), { root: 10, quality: "" });
  assert.deepEqual(parseChordSymbol("E5"), { root: 4, quality: "5" });
  // Slash bass is dropped — we don't voice inversions yet.
  assert.deepEqual(parseChordSymbol("C/G"), { root: 0, quality: "" });
  assert.equal(parseChordSymbol("H7"), null, "invalid root letter");
  assert.equal(parseChordSymbol(""), null);
});

test("open chords use their open shapes", () => {
  const g = voicingFor("G");
  assert.ok(g);
  assert.deepEqual(g.frets, [3, 2, 0, 0, 0, 3]);
  assert.equal(g.baseFret, 0, "an open shape has no barre");
  assert.equal(g.barre, undefined);

  const am = voicingFor("Am");
  assert.ok(am);
  assert.deepEqual(am.frets, [-1, 0, 2, 2, 1, 0]);
});

test("chords without an open shape fall back to the lowest barre", () => {
  // F#m has no open shape. E-shape barre puts it at fret 2, A-shape at fret 9.
  const fsm = voicingFor("F#m");
  assert.ok(fsm);
  assert.equal(fsm.baseFret, 2, "should pick the lower of the two barre positions");
  assert.ok(fsm.barre, "barre shapes report their barre");
  assert.deepEqual(fsm.frets, [2, 4, 4, 2, 2, 2]);
});

test("a voicing's frets actually sound the right chord", () => {
  for (const symbol of ["C", "G", "Am", "F#m", "Bb", "D7", "E5"]) {
    const v = voicingFor(symbol);
    assert.ok(v, `${symbol} should have a voicing`);

    const parsed = parseChordSymbol(symbol);
    assert.ok(parsed);

    const pitchClasses = new Set(
      v.frets
        .map((fret, s) => (fret < 0 ? null : (STANDARD_GUITAR[s] + fret) % 12))
        .filter((pc): pc is number => pc !== null),
    );

    assert.ok(
      pitchClasses.has(parsed.root),
      `${symbol}: voicing must contain the root (got ${[...pitchClasses]})`,
    );

    // Major/minor third, where the quality implies one.
    if (parsed.quality === "") {
      assert.ok(pitchClasses.has((parsed.root + 4) % 12), `${symbol}: major third`);
    } else if (parsed.quality === "m") {
      assert.ok(pitchClasses.has((parsed.root + 3) % 12), `${symbol}: minor third`);
    }
    // A power chord is root + fifth and deliberately has no third.
    if (parsed.quality === "5") {
      assert.ok(pitchClasses.has((parsed.root + 7) % 12), `${symbol}: fifth`);
      assert.equal(pitchClasses.size, 2, "power chords are two pitch classes");
    }
  }
});

test("unknown or unvoiceable symbols return null rather than guessing", () => {
  assert.equal(voicingFor("N.C."), null);
  assert.equal(voicingFor(""), null);
  assert.equal(voicingFor("Cmaj13#11"), null, "we don't have that shape");
});

test("highway notes resolve ticks into recording milliseconds", () => {
  const track: ChartTrack = {
    id: "g",
    name: "Guitar",
    kind: "guitar",
    source: "analyzer",
    notes: [
      { tick: 0, durationTicks: PPQ, string: 0, fret: 3, midi: 43 },
      { tick: PPQ, durationTicks: PPQ, string: 1, fret: 2, midi: 47 },
    ],
  };

  // 120bpm starting at 1s: one beat = 500ms.
  const map = new TickMap([
    { mediaMs: 1000, tick: 0 },
    { mediaMs: 3000, tick: 4 * PPQ },
  ]);

  const notes = buildHighwayNotes(track, map);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].mediaMs, 1000);
  assert.equal(notes[0].durationMs, 500);
  assert.equal(notes[1].mediaMs, 1500);
});

test("simultaneous notes are grouped as one chord", () => {
  const track: ChartTrack = {
    id: "g",
    name: "Guitar",
    kind: "guitar",
    source: "user",
    notes: [
      { tick: 0, durationTicks: PPQ, string: 0, fret: 3, midi: 43 },
      { tick: 0, durationTicks: PPQ, string: 1, fret: 2, midi: 47 },
      { tick: 0, durationTicks: PPQ, string: 2, fret: 0, midi: 50 },
      { tick: 4 * PPQ, durationTicks: PPQ, string: 0, fret: 5, midi: 45 },
    ],
  };
  const map = new TickMap([
    { mediaMs: 0, tick: 0 },
    { mediaMs: 2000, tick: 4 * PPQ },
  ]);

  const notes = buildHighwayNotes(track, map);
  assert.equal(notes[0].chordGroup, notes[1].chordGroup, "struck together");
  assert.equal(notes[1].chordGroup, notes[2].chordGroup);
  assert.notEqual(notes[3].chordGroup, notes[0].chordGroup, "a bar later is separate");
});

test("a track with no notes yields no highway notes", () => {
  const empty: ChartTrack = {
    id: "x", name: "Empty", kind: "guitar", source: "user", notes: [],
  };
  assert.deepEqual(buildHighwayNotes(empty, new TickMap([])), []);
});

test("firstNoteAtOrAfter finds the visible window", () => {
  const notes: HighwayNote[] = [0, 1000, 2000, 3000].map((mediaMs) => ({
    mediaMs, durationMs: 100, string: 0, fret: 0, midi: 40, chordGroup: 0,
  }));

  assert.equal(firstNoteAtOrAfter(notes, -1), 0);
  assert.equal(firstNoteAtOrAfter(notes, 0), 0, "inclusive at the boundary");
  assert.equal(firstNoteAtOrAfter(notes, 1500), 2);
  assert.equal(firstNoteAtOrAfter(notes, 3000), 3);
  assert.equal(firstNoteAtOrAfter(notes, 9999), 4, "past the end");
  assert.equal(firstNoteAtOrAfter([], 100), 0, "empty is safe");
});

test("chordsAround reports the current and next chord", () => {
  const chords = [
    { mediaMs: 0, symbol: "C" },
    { mediaMs: 2000, symbol: "G" },
    { mediaMs: 4000, symbol: "Am" },
  ];

  const atStart = chordsAround(chords, 500);
  assert.equal(atStart.current, "C");
  assert.equal(atStart.next, "G");
  assert.equal(atStart.nextInMs, 1500);

  const onLast = chordsAround(chords, 5000);
  assert.equal(onLast.current, "Am");
  assert.equal(onLast.next, null, "nothing after the last chord");

  const beforeFirst = chordsAround(chords, -100);
  assert.equal(beforeFirst.current, null);
  assert.equal(beforeFirst.next, "C");

  assert.deepEqual(chordsAround([], 0), { current: null, next: null, nextInMs: 0 });
});

test("sync validation catches anchors that would run time backwards", () => {
  const ticksPerBar = 4 * PPQ;
  const backwards = [
    { mediaMs: 5000, tick: 0 },
    { mediaMs: 3000, tick: ticksPerBar },
  ];
  const problems = validateSyncPoints(backwards, ticksPerBar);
  assert.ok(problems.length > 0, "a non-monotonic anchor must be flagged");
  assert.match(problems[0], /backwards/);
});

test("sync validation catches implausible tempos", () => {
  const ticksPerBar = 4 * PPQ;
  // 8 bars in 0.5s implies ~3840 BPM — clearly a mis-set anchor.
  const absurd = [
    { mediaMs: 0, tick: 0 },
    { mediaMs: 500, tick: 8 * ticksPerBar },
  ];
  const problems = validateSyncPoints(absurd, ticksPerBar);
  assert.ok(problems.length > 0);
  assert.match(problems[0], /BPM/);
});

test("sync validation is quiet about a sane alignment", () => {
  const ticksPerBar = 4 * PPQ;
  // 120bpm: one 4/4 bar = 2s.
  const sane = [
    { mediaMs: 0, tick: 0 },
    { mediaMs: 2000, tick: ticksPerBar },
    { mediaMs: 4000, tick: 2 * ticksPerBar },
  ];
  assert.deepEqual(validateSyncPoints(sane, ticksPerBar), []);
});

test("implied tempo from taps ignores a single fumbled tap", () => {
  // Four bars at exactly 2s each = 120 BPM in 4/4.
  assert.equal(impliedBpmFromTaps([0, 2000, 4000, 6000]), 120);
  // One tap badly late — the median holds.
  assert.equal(impliedBpmFromTaps([0, 2000, 4000, 4300, 6000]), 120);
  assert.equal(impliedBpmFromTaps([1000]), null, "one tap says nothing");
  assert.equal(impliedBpmFromTaps([]), null);
});

test("nudging shifts every anchor and leaves ticks alone", () => {
  const points = [
    { mediaMs: 1000, tick: 0 },
    { mediaMs: 3000, tick: 4 * PPQ },
  ];
  const moved = offsetSyncPoints(points, -250);
  assert.deepEqual(moved.map((p) => p.mediaMs), [750, 2750]);
  assert.deepEqual(moved.map((p) => p.tick), [0, 4 * PPQ], "musical time is untouched");
});
