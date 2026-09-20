/**
 * Turning a pasted chord sheet into a synced JammerChart.
 *
 * THE TIMING PROBLEM, AND WHY TAPPING SOLVES IT CLEANLY
 * -----------------------------------------------------
 * A chord sheet from the web has no timing at all. It says "C then G then Am then F",
 * not when. Everything Jammer does depends on when.
 *
 * You could guess: estimate a tempo, assume every chord lasts a bar. That is wrong
 * constantly — intros, half-bar changes, a held chord under a solo — and a chart that
 * is subtly wrong is worse than none, because you blame your own playing.
 *
 * So the user taps once through the song, one tap per chord change. It takes exactly
 * as long as the song does, once, forever. And it's not really work: you're listening
 * to the track anyway, and tapping on the changes is what a musician does instinctively.
 *
 * HOW THE TAPS BECOME A CHART
 * ---------------------------
 * Each chord gets one slot, a quarter note wide, so chord i sits at tick i * PPQ. Each
 * tap becomes a sync point tying that tick to the millisecond it was tapped at.
 *
 * That's deliberate. It means no tempo has to be estimated, no assumption is made
 * about how many beats a chord lasts, and the TickMap resolves chord i to exactly the
 * moment you tapped. Ticks here are an ordering device rather than real musical time —
 * which is honest, because a chord sheet doesn't carry real musical time either.
 */

import { voicingFor, STANDARD_GUITAR } from "./fretboard.ts";
import type {
  ChartTrack,
  ChordEvent,
  JammerChart,
  KeyMarker,
  RecordingRef,
  SectionMarker,
  SyncPoint,
  TabNote,
} from "./types.ts";
import { PPQ } from "./types.ts";
import type { ParsedChordSheet } from "./chord-sheet.ts";

export interface TimedChord {
  symbol: string;
  mediaMs: number;
  sectionLabel?: string;
}

/**
 * Notes for the highway, from chord shapes.
 *
 * A chord chart has no tab, so the highway would otherwise be empty. Strumming the
 * chord's voicing gives it something true to show: these strings, these frets, now.
 * Strings are spread over a few milliseconds so it reads as a strum rather than a
 * block — and because that's what a strum is.
 */
function strumNotes(
  symbol: string,
  tick: number,
  durationTicks: number,
  spreadTicks = PPQ / 32,
): TabNote[] {
  const voicing = voicingFor(symbol);
  if (!voicing) return [];

  const notes: TabNote[] = [];
  let order = 0;

  voicing.frets.forEach((fret, string) => {
    if (fret < 0) return;
    notes.push({
      tick: tick + order * spreadTicks,
      durationTicks: Math.max(PPQ / 8, durationTicks - order * spreadTicks),
      string,
      fret,
      midi: STANDARD_GUITAR[string] + fret,
      velocity: 90,
    });
    order++;
  });

  return notes;
}

export interface BuildOptions {
  title: string;
  artist: string;
  recording: RecordingRef;
  /** From the sheet's header, if it had one. */
  capo?: number;
  key?: string;
  /** Generate strummed notes so the highway has something to show. */
  withStrums?: boolean;
}

export function chartFromTimedChords(
  timed: TimedChord[],
  options: BuildOptions,
): JammerChart {
  const nowIso = new Date().toISOString();
  const slot = PPQ;

  const chords: ChordEvent[] = [];
  const sections: SectionMarker[] = [];
  const syncPoints: SyncPoint[] = [];
  const strums: TabNote[] = [];

  let lastSection: string | undefined;

  timed.forEach((chord, i) => {
    const tick = i * slot;

    chords.push({
      tick,
      durationTicks: slot,
      symbol: chord.symbol,
      root: rootOf(chord.symbol),
      // Hand-timed against the actual recording — as confident as it gets.
      confidence: 1,
    });

    syncPoints.push({ mediaMs: chord.mediaMs, tick, confirmed: true });

    if (chord.sectionLabel && chord.sectionLabel !== lastSection) {
      sections.push({ tick, label: chord.sectionLabel });
      lastSection = chord.sectionLabel;
    }

    if (options.withStrums) {
      strums.push(...strumNotes(chord.symbol, tick, slot));
    }
  });

  const tracks: ChartTrack[] = options.withStrums && strums.length
    ? [
        {
          id: "strum",
          name: "Chords (strummed)",
          kind: "guitar",
          tuning: { strings: STANDARD_GUITAR, label: "Standard" },
          capo: options.capo ?? 0,
          notes: strums,
          source: "user",
        },
      ]
    : [];

  const keys: KeyMarker[] = [];
  if (options.key) {
    const parsed = parseKeyString(options.key);
    if (parsed) keys.push({ tick: 0, ...parsed, confidence: 1 });
  }

  // Tempo is displayed, not used for timing — the sync points carry the truth.
  const bpm = estimateBpm(timed);

  return {
    id: crypto.randomUUID(),
    version: 1,
    title: options.title,
    artist: options.artist,
    ppq: PPQ,
    tempos: [{ tick: 0, bpm }],
    timeSignatures: [{ tick: 0, timeSignature: { numerator: 4, denominator: 4 } }],
    keys,
    sections,
    chords,
    tracks,
    syncSets: [
      {
        id: crypto.randomUUID(),
        recording: options.recording,
        points: syncPoints,
        updatedAt: nowIso,
      },
    ],
    source: "user",
    createdAt: nowIso,
    updatedAt: nowIso,
    confidence: { chords: 1 },
  };
}

/**
 * A rough tempo from the tap intervals, for the BPM readout only.
 *
 * Chords don't all last the same time, so the mean is meaningless. The median interval
 * is usually one bar, so 4 beats — a reasonable guess that's clearly labelled as one.
 */
function estimateBpm(timed: TimedChord[]): number {
  if (timed.length < 3) return 120;

  const gaps: number[] = [];
  for (let i = 1; i < timed.length; i++) {
    const gap = timed[i].mediaMs - timed[i - 1].mediaMs;
    if (gap > 100) gaps.push(gap);
  }
  if (gaps.length === 0) return 120;

  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const bpm = (60_000 / median) * 4;

  // Fold into a plausible range — a chord held for two bars would otherwise read
  // as half tempo.
  let out = bpm;
  while (out < 60) out *= 2;
  while (out > 200) out /= 2;
  return Math.round(out);
}

function rootOf(symbol: string): number | null {
  const match = /^([A-G])(#|b)?/.exec(symbol);
  if (!match) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]];
  if (base === undefined) return null;
  if (match[2] === "#") return (base + 1) % 12;
  if (match[2] === "b") return (base + 11) % 12;
  return base;
}

function parseKeyString(
  key: string,
): { tonic: number; mode: "major" | "minor" } | null {
  const match = /^([A-G])(#|b)?\s*(m|min|minor)?/i.exec(key.trim());
  if (!match) return null;
  const tonic = rootOf(`${match[1]}${match[2] ?? ""}`);
  if (tonic === null) return null;
  return { tonic, mode: match[3] ? "minor" : "major" };
}

/**
 * Build a chart when the user would rather not tap: assume every chord lasts one bar
 * at a stated tempo.
 *
 * Offered because for a lot of simple songs it's right, and it takes ten seconds
 * instead of four minutes. It is clearly wrong wherever the song isn't uniform, so
 * the UI labels it an estimate and points at the Align tool.
 */
export function timedChordsFromTempo(
  sequence: ParsedChordSheet["sequence"],
  bpm: number,
  startMs: number,
  beatsPerChord = 4,
): TimedChord[] {
  const msPerChord = (60_000 / bpm) * beatsPerChord;
  return sequence.map((chord, i) => ({
    symbol: chord.symbol,
    mediaMs: startMs + i * msPerChord,
    sectionLabel: chord.sectionLabel,
  }));
}
