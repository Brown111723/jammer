/**
 * Guitar Pro / MusicXML file -> JammerChart.
 *
 * A notation file is the best chart source there is: a human wrote down every note,
 * string and fret. Loading one should fill the highway, the chord panel, the tempo and
 * key readouts and the bar grid — not just draw notation beside an empty highway.
 *
 * alphaTab parses the file; this turns its model into a chart.
 *
 * THE PART THAT'S EASY TO GET WRONG: REPEATS
 * ------------------------------------------
 * Notation is written compactly — "play bars 9-12 twice", first and second endings.
 * A recording is played linearly. If notes were laid out in *written* order, the
 * highway would fall a whole section behind the record at the first repeat sign.
 *
 * alphaTab's MIDI generator already knows how to unroll repeats and alternate endings,
 * and exposes the result as a tick lookup: one entry per bar in the order it's actually
 * played, with its start tick and tempo. We walk that, not the written bar list. For
 * The Screaming Jets' "Better" that turns 65 written bars into 93 played ones.
 *
 * TICKS
 * -----
 * alphaTab's playback ticks are 960 PPQ, the same as Jammer's, so chart ticks here ARE
 * alphaTab's ticks. That's what lets the notation cursor and the highway share one
 * alignment (see `scoreTiming` in types.ts).
 */

import type {
  Beat,
  ChartTrack,
  ChordEvent,
  JammerChart,
  KeyMarker,
  RecordingRef,
  SectionMarker,
  SyncPoint,
  TabNote,
  TempoMarker,
} from "./types.ts";
import { PPQ } from "./types.ts";

/* The slices of alphaTab's model we read, typed structurally so this module doesn't
   need alphaTab's types (or alphaTab itself) at import time — it's passed in. */

interface AtNote {
  string: number; // 1-based, 1 = lowest string
  fret: number;
  realValue: number; // MIDI pitch
  isTieDestination?: boolean;
  isDead?: boolean;
  isGhost?: boolean;
  isPalmMute?: boolean;
  isHammerPullOrigin?: boolean;
  slideOutType?: number;
  hasBend?: boolean;
  harmonicType?: number; // 0 = none
  vibrato?: number;
}
interface AtBeat {
  notes: AtNote[];
  isRest?: boolean;
  playbackStart: number; // relative to bar start
  playbackDuration: number;
  hasChord?: boolean;
  chord?: { name?: string } | null;
}
interface AtBar { voices: { beats: AtBeat[] }[] }
interface AtStaff {
  bars: AtBar[];
  isPercussion?: boolean;
  tuning: number[]; // high to low
  capo?: number;
}
interface AtTrack { index: number; name: string; staves: AtStaff[] }
interface AtMasterBar {
  index: number;
  section?: { text?: string } | null;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  keySignature?: number; // -7..7 on the circle of fifths
  keySignatureType?: number; // 0 major, 1 minor
}
export interface AtScore {
  title?: string;
  artist?: string;
  album?: string;
  tempo: number;
  masterBars: AtMasterBar[];
  tracks: AtTrack[];
}
interface AtBarLookup {
  masterBar: AtMasterBar;
  start: number;
  end: number;
  tempoChanges?: { tick: number; tempo: number }[];
  tempo?: number;
}

/** The alphaTab module, passed in so this works in the browser and under Node. */
export interface AlphaTabModule {
  Settings: new () => unknown;
  midi: {
    MidiFile: new () => unknown;
    MidiFileGenerator: new (
      score: unknown,
      settings: unknown,
      handler: unknown,
    ) => { generate(): void; tickLookup: { masterBars: AtBarLookup[] } };
    AlphaSynthMidiFileHandler: new (midi: unknown) => unknown;
  };
}

/** The bars in the order they are actually played, repeats unrolled. */
export function playbackBars(
  alphaTab: AlphaTabModule,
  score: AtScore,
  settings?: unknown,
): AtBarLookup[] {
  const midi = new alphaTab.midi.MidiFile();
  const generator = new alphaTab.midi.MidiFileGenerator(
    score,
    settings ?? new alphaTab.Settings(),
    new alphaTab.midi.AlphaSynthMidiFileHandler(midi),
  );
  generator.generate();
  return generator.tickLookup.masterBars;
}

/**
 * The file's own tick -> ms mapping: one anchor per played bar, plus one at every
 * tempo change, so the piecewise-linear TickMap reproduces the tempo map exactly.
 */
export function scoreTimingFrom(bars: AtBarLookup[], fallbackBpm: number): {
  points: SyncPoint[];
  tempos: TempoMarker[];
  durationMs: number;
} {
  const points: SyncPoint[] = [];
  const tempos: TempoMarker[] = [];

  let ms = 0;
  let tick = bars.length ? bars[0].start : 0;
  let bpm = fallbackBpm;

  const advanceTo = (target: number) => {
    ms += ((target - tick) / PPQ) * (60_000 / bpm);
    tick = target;
  };

  for (const bar of bars) {
    advanceTo(bar.start);
    points.push({ tick: bar.start, mediaMs: ms });

    const changes = [...(bar.tempoChanges ?? [])].sort((a, b) => a.tick - b.tick);
    if (changes.length === 0 && bar.tempo) {
      changes.push({ tick: bar.start, tempo: bar.tempo });
    }

    for (const change of changes) {
      const at = Math.max(bar.start, Math.min(bar.end, change.tick));
      if (change.tempo === bpm && tempos.length) continue;
      advanceTo(at);
      if (at !== bar.start) points.push({ tick: at, mediaMs: ms });
      bpm = change.tempo;
      if (!tempos.length || tempos[tempos.length - 1].bpm !== bpm) {
        tempos.push({ tick: at, bpm });
      }
    }

    advanceTo(bar.end);
  }

  // A final anchor at the very end, so extrapolation past the last bar isn't needed.
  if (bars.length) points.push({ tick, mediaMs: ms });

  if (!tempos.length) tempos.push({ tick: 0, bpm: fallbackBpm });
  return { points: dedupe(points), tempos, durationMs: ms };
}

function dedupe(points: SyncPoint[]): SyncPoint[] {
  const out: SyncPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.tick === p.tick) continue;
    out.push(p);
  }
  return out;
}

function techniquesOf(note: AtNote): TabNote["techniques"] {
  const t: NonNullable<TabNote["techniques"]> = [];
  if (note.isHammerPullOrigin) t.push("hammer");
  if (note.slideOutType) t.push("slide");
  if (note.hasBend) t.push("bend");
  if (note.vibrato) t.push("vibrato");
  if (note.isPalmMute) t.push("palmMute");
  if (note.harmonicType) t.push("harmonic");
  if (note.isGhost) t.push("ghost");
  if (note.isDead) t.push("dead");
  return t.length ? t : undefined;
}

/**
 * Key from the key signature — but only when one was actually set.
 *
 * Tab writers routinely leave the signature at zero sharps/flats whatever key the song
 * is in. Zero therefore means "unknown" far more often than "C major", and showing C
 * for a song in A would be confidently wrong. We stay quiet instead.
 */
function keyFrom(bar: AtMasterBar | undefined): KeyMarker[] {
  if (!bar || !bar.keySignature) return [];
  const majorTonic = (((bar.keySignature * 7) % 12) + 12) % 12;
  const minor = bar.keySignatureType === 1;
  return [
    {
      tick: 0,
      tonic: minor ? (majorTonic + 9) % 12 : majorTonic,
      mode: minor ? "minor" : "major",
      confidence: 0.9,
    },
  ];
}

export interface ScoreToChartOptions {
  recording: RecordingRef;
  fileName: string;
  fileSize: number;
  /** Reuse an id when re-importing for the same song, so charts don't pile up. */
  id?: string;
  /** Fallbacks when the file's own metadata is blank. */
  title?: string;
  artist?: string;
  settings?: unknown;
}

export function scoreToChart(
  alphaTab: AlphaTabModule,
  score: AtScore,
  options: ScoreToChartOptions,
): JammerChart {
  const bars = playbackBars(alphaTab, score, options.settings);
  const timing = scoreTimingFrom(bars, score.tempo || 120);
  const nowIso = new Date().toISOString();

  // ---- tracks: one per string instrument, notes in PLAYED order
  const tracks: ChartTrack[] = [];

  for (const track of score.tracks) {
    const staff = track.staves[0];
    if (!staff || staff.isPercussion || !staff.tuning?.length) continue;

    const tuningLowToHigh = [...staff.tuning].reverse();
    const stringCount = tuningLowToHigh.length;
    const notes: TabNote[] = [];

    for (const lookup of bars) {
      const bar = staff.bars[lookup.masterBar.index];
      if (!bar) continue;

      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          if (beat.isRest || !beat.notes.length) continue;
          for (const note of beat.notes) {
            // A tied note continues the previous one; striking it again would put a
            // second note on the highway that you shouldn't play.
            if (note.isTieDestination) continue;
            const string = note.string - 1; // alphaTab: 1 = lowest
            if (string < 0 || string >= stringCount) continue;
            notes.push({
              tick: lookup.start + beat.playbackStart,
              durationTicks: Math.max(1, beat.playbackDuration),
              string,
              fret: note.fret,
              // The FRETTED pitch, not alphaTab's realValue. For a harmonic,
              // realValue is the pitch that sounds (an octave or more up), but this
              // field exists so a retune or capo can re-derive frets — and doing that
              // from the sounding pitch would move the note to the wrong fret. The
              // harmonic itself is recorded as a technique.
              midi: tuningLowToHigh[string] + note.fret,
              techniques: techniquesOf(note),
            });
          }
        }
      }
    }

    notes.sort((a, b) => a.tick - b.tick || a.string - b.string);

    const isBass =
      stringCount <= 5 && tuningLowToHigh[0] < 36 ||
      /bass/i.test(track.name);

    tracks.push({
      id: `track-${track.index}`,
      name: track.name || `Track ${track.index + 1}`,
      kind: isBass ? "bass" : "guitar",
      tuning: { strings: tuningLowToHigh },
      capo: staff.capo ?? 0,
      notes,
      source: "import",
    });
  }

  // ---- chords: named chord symbols from whichever track carries them
  const chords: ChordEvent[] = [];
  const chordTrack = score.tracks.find((t) =>
    t.staves[0]?.bars.some((b) => b.voices.some((v) => v.beats.some((x) => x.hasChord))),
  );

  if (chordTrack) {
    const staff = chordTrack.staves[0];
    for (const lookup of bars) {
      const bar = staff.bars[lookup.masterBar.index];
      if (!bar) continue;
      for (const beat of bar.voices[0]?.beats ?? []) {
        const raw = beat.hasChord ? beat.chord?.name : undefined;
        const name = raw ? normaliseChordName(raw) : undefined;
        if (!name) continue;
        const tick = lookup.start + beat.playbackStart;
        const prev = chords[chords.length - 1];
        if (prev && prev.symbol === name) continue;
        chords.push({
          tick,
          durationTicks: PPQ,
          symbol: name,
          root: rootOf(name),
          confidence: 1,
        });
      }
    }
    // Each chord lasts until the next one.
    for (let i = 0; i < chords.length; i++) {
      const next = chords[i + 1]?.tick ?? bars[bars.length - 1]?.end ?? chords[i].tick + PPQ;
      chords[i].durationTicks = Math.max(1, next - chords[i].tick);
    }
  }

  // ---- sections, every time they're played
  const sections: SectionMarker[] = [];
  for (const lookup of bars) {
    const label = lookup.masterBar.section?.text?.trim();
    if (label) sections.push({ tick: lookup.start, label });
  }

  // ---- beat grid in the file's native timing (remapped at display time)
  const beats: Beat[] = [];
  const msAt = makeTickToMs(timing.points);
  bars.forEach((lookup, i) => {
    const num = lookup.masterBar.timeSignatureNumerator || 4;
    const den = lookup.masterBar.timeSignatureDenominator || 4;
    const beatTicks = (PPQ * 4) / den;
    for (let b = 0; b < num; b++) {
      const tick = lookup.start + b * beatTicks;
      if (tick >= lookup.end) break;
      beats.push({ mediaMs: msAt(tick), beatInBar: b + 1, bar: i + 1, confidence: 1 });
    }
  });

  const first = score.masterBars[0];

  return {
    id: options.id ?? crypto.randomUUID(),
    version: 1,
    // The caller's title/artist win: they're what the song is called where it plays,
    // which is what the next lookup will search by.
    title: options.title?.trim() || score.title?.trim() || options.fileName,
    artist: options.artist?.trim() || score.artist?.trim() || "",
    album: score.album?.trim() || undefined,
    ppq: PPQ,
    tempos: timing.tempos,
    timeSignatures: [
      {
        tick: 0,
        timeSignature: {
          numerator: first?.timeSignatureNumerator || 4,
          denominator: first?.timeSignatureDenominator || 4,
        },
      },
    ],
    keys: keyFrom(first),
    sections,
    chords,
    tracks,
    beatGrid: {
      beats,
      nominalBpm: timing.tempos[0]?.bpm ?? score.tempo,
    },
    syncSets: [
      {
        id: crypto.randomUUID(),
        recording: options.recording,
        // Start from the file's own timing. The user nudges from here if the
        // recording has a different lead-in.
        points: timing.points.map((p) => ({ ...p, confirmed: false })),
        updatedAt: nowIso,
      },
    ],
    scoreTiming: timing.points,
    scoreFile: { name: options.fileName, size: options.fileSize },
    source: "import",
    createdAt: nowIso,
    updatedAt: nowIso,
    confidence: { beats: 1, chords: chords.length ? 1 : undefined },
  };
}

function makeTickToMs(points: SyncPoint[]): (tick: number) => number {
  return (tick: number) => {
    if (!points.length) return 0;
    let i = 1;
    while (i < points.length - 1 && points[i].tick < tick) i++;
    const a = points[Math.max(0, i - 1)];
    const b = points[i] ?? a;
    if (b.tick === a.tick) return a.mediaMs;
    return a.mediaMs + ((tick - a.tick) / (b.tick - a.tick)) * (b.mediaMs - a.mediaMs);
  };
}

/**
 * Tidy a chord name as typed into Guitar Pro into the symbol the rest of Jammer uses.
 * Tab authors write power chords as "A (no 3rd)", "A no3" or "A5"; all become "A5".
 */
export function normaliseChordName(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  const no3 = /\(?\s*no\s*3(rd)?\s*\)?/i;
  if (no3.test(s)) {
    const root = /^[A-G][#b]?/.exec(s)?.[0];
    const rest = s.replace(no3, "").trim();
    if (root && rest === root) return `${root}5`;
    s = rest;
  }
  return s.replace(/\s+/g, "");
}

function rootOf(symbol: string): number | null {
  const m = /^([A-G])(#|b)?/.exec(symbol);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  if (base === undefined) return null;
  if (m[2] === "#") return (base + 1) % 12;
  if (m[2] === "b") return (base + 11) % 12;
  return base;
}
