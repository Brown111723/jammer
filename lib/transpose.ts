/**
 * Transposition, capo and alternate tunings.
 *
 * THE DISTINCTION THAT MATTERS
 * ----------------------------
 * "Transpose" means two genuinely different things, and conflating them is why so many
 * tab apps are confusing:
 *
 *   SOUNDING transpose   — the music comes out in a different key. Useful for singing
 *                          a song lower, or matching a horn player. But the chart no
 *                          longer matches the recording, so you can't jam along unless
 *                          the audio is shifted too (see `pitch-shift.ts` — local files
 *                          only, because streamed audio is DRM-protected).
 *
 *   FINGERING transpose  — the music sounds exactly the same, but you play it
 *                          somewhere else on the neck. This is what a capo does, and
 *                          what happens when you re-fret for a different tuning.
 *                          **The chart still matches the recording**, so this is the
 *                          one you want for jamming, and it works on every transport.
 *
 * The common real case is fingering, not sounding: a huge amount of rock is recorded a
 * half step down (Hendrix, Guns N' Roses, Stevie Ray Vaughan, most modern metal). You
 * tune your guitar to Eb, Jammer re-frets the chart for Eb tuning, and you play
 * familiar shapes that sound right against the record. No audio processing needed.
 */

import type {
  ChartTrack,
  ChordEvent,
  JammerChart,
  KeyMarker,
  TabNote,
} from "./types.ts";
import { PITCH_NAMES, parseChordSymbol } from "./fretboard.ts";

export const TUNINGS: Record<string, { strings: number[]; label: string }> = {
  standard: { strings: [40, 45, 50, 55, 59, 64], label: "Standard (EADGBE)" },
  halfStepDown: { strings: [39, 44, 49, 54, 58, 63], label: "Half step down (Eb)" },
  wholeStepDown: { strings: [38, 43, 48, 53, 57, 62], label: "Whole step down (D)" },
  dropD: { strings: [38, 45, 50, 55, 59, 64], label: "Drop D" },
  dropC: { strings: [36, 43, 48, 53, 57, 62], label: "Drop C" },
  openG: { strings: [38, 43, 50, 55, 59, 62], label: "Open G" },
  openD: { strings: [38, 45, 50, 54, 57, 62], label: "Open D" },
  dadgad: { strings: [38, 45, 50, 55, 57, 62], label: "DADGAD" },
  bassStandard: { strings: [28, 33, 38, 43], label: "Bass standard (EADG)" },
  bassHalfDown: { strings: [27, 32, 37, 42], label: "Bass half step down" },
  bassDropD: { strings: [26, 33, 38, 43], label: "Bass drop D" },
};

export interface FretboardConfig {
  /** MIDI note of each open string, low to high. */
  tuning: number[];
  /** Capo fret. 0 = none. Frets are displayed relative to the capo. */
  capo: number;
  /**
   * SOUNDING transpose in semitones. Changes the actual pitch, so it only matches the
   * recording if the audio is shifted by the same amount.
   */
  transposeSemitones: number;
}

export const DEFAULT_FRETBOARD: FretboardConfig = {
  tuning: TUNINGS.standard.strings,
  capo: 0,
  transposeSemitones: 0,
};

// ---------------------------------------------------------------- fret assignment

/**
 * MIDI → (string, fret) by Viterbi over fingering candidates, same cost model as the
 * Python analyzer: a guitarist keeps their hand still, so the cost of a note is how
 * far the hand must travel to reach it.
 *
 * This runs client-side because changing tuning or capo must re-fret the whole chart
 * instantly — round-tripping to the analyzer for a dropdown change would be absurd.
 */
export function assignFrets(
  notes: { tick: number; midi: number }[],
  tuning: number[],
  options: { maxFret?: number; capo?: number; openStringBonus?: number } = {},
): { string: number; fret: number }[] {
  const maxFret = options.maxFret ?? 22;
  const capo = options.capo ?? 0;
  const openBonus = options.openStringBonus ?? 1.5;

  if (notes.length === 0) return [];

  // With a capo, the lowest available fret on every string is the capo fret, and
  // "open" means fretted at the capo.
  const candidates: [number, number][][] = notes.map((note) => {
    const options: [number, number][] = [];
    for (let s = 0; s < tuning.length; s++) {
      const fret = note.midi - tuning[s];
      if (fret >= capo && fret <= maxFret) options.push([s, fret]);
    }
    if (options.length === 0) {
      // Out of range: clamp to the nearest string rather than dropping the note.
      let closest = 0;
      for (let s = 1; s < tuning.length; s++) {
        if (Math.abs(note.midi - tuning[s]) < Math.abs(note.midi - tuning[closest])) {
          closest = s;
        }
      }
      options.push([
        closest,
        Math.max(capo, Math.min(maxFret, note.midi - tuning[closest])),
      ]);
    }
    return options;
  });

  const costs: number[][] = candidates.map((c) => new Array(c.length).fill(0));
  const back: number[][] = candidates.map((c) => new Array(c.length).fill(0));
  const PPQ_GAP = 1920; // two quarter notes

  for (let j = 0; j < candidates[0].length; j++) {
    const fret = candidates[0][j][1];
    costs[0][j] = fret === capo ? -openBonus : fret * 0.1;
  }

  for (let i = 1; i < notes.length; i++) {
    const gap = notes[i].tick - notes[i - 1].tick;
    // Notes far apart in time don't constrain each other — there's time to move.
    const travelWeight = gap < PPQ_GAP ? 1 : 0.25;

    for (let j = 0; j < candidates[i].length; j++) {
      const [string, fret] = candidates[i][j];
      const local = (fret === capo ? -openBonus : 0) + fret * 0.05;

      let bestCost = Infinity;
      let bestK = 0;
      for (let k = 0; k < candidates[i - 1].length; k++) {
        const [prevString, prevFret] = candidates[i - 1][k];
        const travel =
          Math.abs(fret - prevFret) * travelWeight +
          Math.abs(string - prevString) * 0.3;
        const total = costs[i - 1][k] + travel;
        if (total < bestCost) {
          bestCost = total;
          bestK = k;
        }
      }
      costs[i][j] = bestCost + local;
      back[i][j] = bestK;
    }
  }

  let j = 0;
  for (let k = 1; k < costs[costs.length - 1].length; k++) {
    if (costs[costs.length - 1][k] < costs[costs.length - 1][j]) j = k;
  }

  const path: number[] = new Array(notes.length);
  for (let i = notes.length - 1; i >= 0; i--) {
    path[i] = j;
    j = back[i][j];
  }

  return path.map((choice, i) => {
    const [string, fret] = candidates[i][choice];
    return { string, fret };
  });
}

// ---------------------------------------------------------------- chart transforms

/**
 * Re-fret a track for a tuning and capo, keeping the sounding pitch identical.
 *
 * This is the fingering transform: the recording still matches, you just play it
 * somewhere else. `transposeSemitones` additionally shifts the sounding pitch, which
 * does NOT match the recording unless the audio is shifted too.
 */
export function refretTrack(track: ChartTrack, config: FretboardConfig): ChartTrack {
  const notes = track.notes ?? [];
  if (notes.length === 0) return track;

  const tuning =
    track.kind === "bass" && config.tuning.length > 4
      ? // A bass chart against a guitar tuning is nonsense; use the low four.
        config.tuning.slice(0, 4)
      : config.tuning;

  const shifted = notes.map((n) => ({
    tick: n.tick,
    midi: n.midi + config.transposeSemitones,
  }));

  const positions = assignFrets(shifted, tuning, { capo: config.capo });

  const out: TabNote[] = notes.map((n, i) => ({
    ...n,
    midi: shifted[i].midi,
    string: positions[i].string,
    // Display frets relative to the capo — that's where your fingers actually go.
    fret: positions[i].fret - config.capo,
  }));

  return {
    ...track,
    notes: out,
    tuning: { strings: tuning, label: describeTuning(tuning) },
    capo: config.capo,
  };
}

export function transposeChordSymbol(symbol: string, semitones: number): string {
  if (semitones === 0 || !symbol || symbol === "N.C.") return symbol;

  const parsed = parseChordSymbol(symbol);
  if (!parsed) return symbol;

  const root = (((parsed.root + semitones) % 12) + 12) % 12;

  // Preserve a slash bass if there was one.
  const slash = symbol.indexOf("/");
  let suffix = parsed.quality;
  if (slash >= 0) {
    const bass = parseChordSymbol(symbol.slice(slash + 1));
    if (bass) {
      const bassRoot = (((bass.root + semitones) % 12) + 12) % 12;
      suffix += `/${PITCH_NAMES[bassRoot]}`;
    }
  }

  return `${PITCH_NAMES[root]}${suffix}`;
}

export function transposeChords(chords: ChordEvent[], semitones: number): ChordEvent[] {
  if (semitones === 0) return chords;
  return chords.map((c) => ({
    ...c,
    symbol: transposeChordSymbol(c.symbol, semitones),
    root: c.root === null ? null : (((c.root + semitones) % 12) + 12) % 12,
  }));
}

export function transposeKeys(keys: KeyMarker[], semitones: number): KeyMarker[] {
  if (semitones === 0) return keys;
  return keys.map((k) => ({
    ...k,
    tonic: (((k.tonic + semitones) % 12) + 12) % 12,
  }));
}

/** Apply a fretboard configuration to a whole chart. */
export function applyFretboard(
  chart: JammerChart,
  config: FretboardConfig,
): JammerChart {
  const unchanged =
    config.transposeSemitones === 0 &&
    config.capo === 0 &&
    sameTuning(config.tuning, TUNINGS.standard.strings);

  if (unchanged) return chart;

  return {
    ...chart,
    tracks: chart.tracks.map((t) =>
      t.kind === "drums" ? t : refretTrack(t, config),
    ),
    chords: transposeChords(chart.chords, config.transposeSemitones),
    keys: transposeKeys(chart.keys, config.transposeSemitones),
  };
}

function sameTuning(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

export function describeTuning(strings: number[]): string {
  for (const t of Object.values(TUNINGS)) {
    if (sameTuning(t.strings, strings)) return t.label;
  }
  return strings.map((m) => PITCH_NAMES[m % 12]).join(" ");
}

/**
 * How many semitones a tuning sits below standard, when it's a uniform shift.
 * Returns null for tunings that aren't a simple transposition (Drop D, DADGAD…).
 *
 * This is what lets Jammer say "this chart is for Eb tuning — tune down a half step,
 * or shift the audio up one" rather than leaving you to work it out.
 */
export function uniformOffsetFromStandard(strings: number[]): number | null {
  const reference =
    strings.length === 4 ? TUNINGS.bassStandard.strings : TUNINGS.standard.strings;
  if (strings.length !== reference.length) return null;

  const offset = strings[0] - reference[0];
  return strings.every((n, i) => n - reference[i] === offset) ? offset : null;
}

export function semitoneLabel(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : ""}${n}`;
}
