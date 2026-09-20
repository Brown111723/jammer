/**
 * Fretboard geometry and chord voicings.
 *
 * Two jobs:
 *   1. Turn a chord symbol into something playable — actual fret positions, not just
 *      a name. "Cmaj7" is useless to a beginner; a diagram with dots is not.
 *   2. Turn chart notes (ticks) into highway notes (milliseconds) for the scrolling view.
 *
 * ON VOICING CHOICE
 * -----------------
 * A chord has many valid voicings and the "right" one depends on context — what your
 * hand just did, what it's about to do. We pick by a simple preference order that
 * matches how most players actually play:
 *
 *   open position  >  low barre  >  high barre
 *
 * Open chords ring louder, are easier, and are overwhelmingly what's used in the
 * rock/pop material this app is for. When no open shape exists we fall back to
 * whichever barre shape (E-shape or A-shape) sits lower on the neck.
 *
 * This is deliberately a lookup, not a solver. A solver that optimises voice-leading
 * across a whole progression is a nice later addition, but it would produce shapes
 * that surprise people, and a surprising chord shape reads as a bug.
 */

import type { TabNote, ChartTrack } from "./types.ts";
import { TickMap } from "./types.ts";

export const STANDARD_GUITAR = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
export const STANDARD_BASS = [28, 33, 38, 43]; // E1 A1 D2 G2
export const DROP_D_GUITAR = [38, 45, 50, 55, 59, 64];

export const STRING_LABELS_GUITAR = ["E", "A", "D", "G", "B", "e"];
export const STRING_LABELS_BASS = ["E", "A", "D", "G"];

/**
 * Per-string colours, low to high. A rainbow up the neck rather than Guitar Hero's
 * arbitrary five, because here a lane *is* a string and the mapping should be
 * learnable — after a few songs you read the colour instead of the label.
 */
export const STRING_COLORS = [
  "#ff5c5c", // low E
  "#ff9f2e", // A
  "#ffd93d", // D
  "#6bcf5f", // G
  "#4dabf7", // B
  "#b197fc", // high e
];

export const PITCH_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

export interface Voicing {
  /** One entry per string, low to high. -1 = don't play, 0 = open. */
  frets: number[];
  /** Fret the barre sits at, or 0 for an open shape. */
  baseFret: number;
  /** Which strings the barre covers, if any. */
  barre?: { fret: number; fromString: number; toString: number };
  name: string;
}

// ---------------------------------------------------------------- open shapes

/** The open chords, by symbol. These are the ones worth hard-coding. */
const OPEN_SHAPES: Record<string, number[]> = {
  C: [-1, 3, 2, 0, 1, 0],
  Cmaj7: [-1, 3, 2, 0, 0, 0],
  C7: [-1, 3, 2, 3, 1, 0],
  D: [-1, -1, 0, 2, 3, 2],
  Dm: [-1, -1, 0, 2, 3, 1],
  D7: [-1, -1, 0, 2, 1, 2],
  Dmaj7: [-1, -1, 0, 2, 2, 2],
  Dm7: [-1, -1, 0, 2, 1, 1],
  Dsus4: [-1, -1, 0, 2, 3, 3],
  Dsus2: [-1, -1, 0, 2, 3, 0],
  E: [0, 2, 2, 1, 0, 0],
  Em: [0, 2, 2, 0, 0, 0],
  E7: [0, 2, 0, 1, 0, 0],
  Em7: [0, 2, 0, 0, 0, 0],
  Emaj7: [0, 2, 1, 1, 0, 0],
  Esus4: [0, 2, 2, 2, 0, 0],
  F: [1, 3, 3, 2, 1, 1],
  Fmaj7: [-1, -1, 3, 2, 1, 0],
  G: [3, 2, 0, 0, 0, 3],
  G7: [3, 2, 0, 0, 0, 1],
  Gmaj7: [3, 2, 0, 0, 0, 2],
  A: [-1, 0, 2, 2, 2, 0],
  Am: [-1, 0, 2, 2, 1, 0],
  A7: [-1, 0, 2, 0, 2, 0],
  Am7: [-1, 0, 2, 0, 1, 0],
  Amaj7: [-1, 0, 2, 1, 2, 0],
  Asus4: [-1, 0, 2, 2, 3, 0],
  Asus2: [-1, 0, 2, 2, 0, 0],
  B7: [-1, 2, 1, 2, 0, 2],
  Bm: [-1, 2, 4, 4, 3, 2],
  // Power chords — the backbone of rock, and almost always missing from chord charts.
  E5: [0, 2, 2, -1, -1, -1],
  A5: [-1, 0, 2, 2, -1, -1],
  D5: [-1, -1, 0, 2, 3, -1],
  G5: [3, 5, 5, -1, -1, -1],
};

// ---------------------------------------------------------------- barre shapes

/**
 * Movable shapes, expressed as offsets from the barre fret.
 * `rootString` says which string carries the root, which is what determines the
 * barre fret for a given chord root.
 */
interface MovableShape {
  offsets: number[];
  rootString: 0 | 1;
  quality: string;
}

const MOVABLE: MovableShape[] = [
  // E-shape (root on low E)
  { quality: "", offsets: [0, 2, 2, 1, 0, 0], rootString: 0 },
  { quality: "m", offsets: [0, 2, 2, 0, 0, 0], rootString: 0 },
  { quality: "7", offsets: [0, 2, 0, 1, 0, 0], rootString: 0 },
  { quality: "m7", offsets: [0, 2, 0, 0, 0, 0], rootString: 0 },
  { quality: "maj7", offsets: [0, 2, 1, 1, 0, 0], rootString: 0 },
  { quality: "sus4", offsets: [0, 2, 2, 2, 0, 0], rootString: 0 },
  { quality: "5", offsets: [0, 2, 2, -1, -1, -1], rootString: 0 },
  // A-shape (root on A)
  { quality: "", offsets: [-1, 0, 2, 2, 2, 0], rootString: 1 },
  { quality: "m", offsets: [-1, 0, 2, 2, 1, 0], rootString: 1 },
  { quality: "7", offsets: [-1, 0, 2, 0, 2, 0], rootString: 1 },
  { quality: "m7", offsets: [-1, 0, 2, 0, 1, 0], rootString: 1 },
  { quality: "maj7", offsets: [-1, 0, 2, 1, 2, 0], rootString: 1 },
  { quality: "sus4", offsets: [-1, 0, 2, 2, 3, 0], rootString: 1 },
  { quality: "5", offsets: [-1, 0, 2, 2, -1, -1], rootString: 1 },
];

const OPEN_STRING_PC = [4, 9, 2, 7, 11, 4]; // E A D G B E as pitch classes

/**
 * Find a playable voicing for a chord symbol.
 * Returns null for symbols we can't parse rather than guessing — a wrong diagram is
 * worse than no diagram.
 */
export function voicingFor(symbol: string): Voicing | null {
  if (!symbol || symbol === "N.C.") return null;

  const open = OPEN_SHAPES[symbol];
  if (open) {
    return { frets: open, baseFret: 0, name: symbol };
  }

  const parsed = parseChordSymbol(symbol);
  if (!parsed) return null;

  const { root, quality } = parsed;

  // Try both barre shapes, take whichever sits lower on the neck.
  const candidates: Voicing[] = [];

  for (const shape of MOVABLE) {
    if (shape.quality !== quality) continue;

    const openPc = OPEN_STRING_PC[shape.rootString];
    let barreFret = (root - openPc + 12) % 12;
    // Fret 0 would be the open shape, which we'd have found above; use fret 12
    // rather than emitting a shape that needs a barre at the nut.
    if (barreFret === 0) barreFret = 12;

    const frets = shape.offsets.map((o) => (o < 0 ? -1 : o + barreFret));

    candidates.push({
      frets,
      baseFret: barreFret,
      barre: {
        fret: barreFret,
        fromString: shape.rootString,
        toString: 5,
      },
      name: symbol,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.baseFret - b.baseFret);
  return candidates[0];
}

/** Split "F#m7" into root pitch class 6 and quality "m7". */
export function parseChordSymbol(
  symbol: string,
): { root: number; quality: string } | null {
  const match = /^([A-G])([#b]?)(.*)$/.exec(symbol.trim());
  if (!match) return null;

  const [, letter, accidental, rest] = match;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
  if (base === undefined) return null;

  let root = base;
  if (accidental === "#") root = (root + 1) % 12;
  if (accidental === "b") root = (root + 11) % 12;

  // Drop any slash-bass; we don't voice inversions yet.
  const quality = rest.split("/")[0];

  return { root, quality };
}

export function midiFor(tuning: number[], string: number, fret: number): number {
  return tuning[string] + fret;
}

export function noteNameFor(midi: number): string {
  return `${PITCH_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

// ---------------------------------------------------------------- highway notes

export interface HighwayNote {
  mediaMs: number;
  durationMs: number;
  string: number;
  fret: number;
  midi: number;
  /** Notes sharing a mediaMs are part of one chord — drawn as a connected group. */
  chordGroup: number;
}

/**
 * Resolve a track's tick-based notes into recording milliseconds, ready for the
 * highway to scroll.
 *
 * This is where the two planes meet: ticks are the chart's own time, the TickMap
 * carries this recording's alignment, and the output is in the same millisecond domain
 * the clock reports.
 */
export function buildHighwayNotes(
  track: ChartTrack,
  tickMap: TickMap,
): HighwayNote[] {
  const notes = track.notes ?? [];
  if (notes.length === 0) return [];

  const resolved = notes
    .map((n: TabNote) => {
      const startMs = tickMap.tickToMs(n.tick);
      const endMs = tickMap.tickToMs(n.tick + n.durationTicks);
      return {
        mediaMs: startMs,
        durationMs: Math.max(40, endMs - startMs),
        string: n.string,
        fret: n.fret,
        midi: n.midi,
        chordGroup: 0,
      };
    })
    .sort((a, b) => a.mediaMs - b.mediaMs || a.string - b.string);

  // Group near-simultaneous notes so the renderer can draw a chord as one unit.
  // 30ms is tighter than a strum but loose enough to survive quantisation noise.
  let group = 0;
  for (let i = 0; i < resolved.length; i++) {
    if (i > 0 && resolved[i].mediaMs - resolved[i - 1].mediaMs > 30) group++;
    resolved[i].chordGroup = group;
  }

  return resolved;
}

/** First index with mediaMs >= target. Binary search; runs every frame. */
export function firstNoteAtOrAfter(notes: HighwayNote[], ms: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].mediaMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Chord active at `ms`, and the one after it. Both may be null. */
export function chordsAround(
  chords: { mediaMs: number; symbol: string }[],
  ms: number,
): { current: string | null; next: string | null; nextInMs: number } {
  if (chords.length === 0) return { current: null, next: null, nextInMs: 0 };

  let lo = 0;
  let hi = chords.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chords[mid].mediaMs <= ms) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const current = idx >= 0 ? chords[idx].symbol : null;
  const nextChord = chords[idx + 1] ?? null;

  return {
    current,
    next: nextChord?.symbol ?? null,
    nextInMs: nextChord ? nextChord.mediaMs - ms : 0,
  };
}
