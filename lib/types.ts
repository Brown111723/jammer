/**
 * The JammerChart format.
 *
 * The central decision here: **musical content is stored in ticks, not seconds.**
 *
 * Seconds belong to a *recording*. Ticks belong to a *song*. If you store the chart in
 * seconds you have welded it to one particular audio file, and you are back to being
 * Songsterr — one chart, one rendition, no alignment to the remaster or the live cut or
 * the slowed-down practice copy.
 *
 * Ticks are mapped to a recording's seconds by a `SyncPointSet`. Many sets can exist per
 * chart, one per recording. That indirection is the product.
 */

/** Pulses per quarter note. 960 matches Guitar Pro / most DAWs. */
export const PPQ = 960;

// ---------------------------------------------------------------- time mapping

/**
 * One anchor tying a position in a recording to a position in the chart.
 *
 * Two points give you offset + linear stretch, which handles the overwhelmingly common
 * cases: a remaster with a different lead-in, a radio edit, a track ripped at 44.1 vs
 * 48 kHz. More points track a live performance that speeds up through the song.
 */
export interface SyncPoint {
  /** Position in the recording, ms from the start of the audio. */
  mediaMs: number;
  /** Position in the chart, in ticks. */
  tick: number;
  /** True if a human placed or confirmed this. Analyzer-generated points are false. */
  confirmed?: boolean;
}

export interface SyncPointSet {
  id: string;
  /** Which recording these points align to. */
  recording: RecordingRef;
  points: SyncPoint[];
  /** Who aligned it, for attribution in a shared catalogue. */
  contributor?: string;
  updatedAt: string;
}

/** Identifies one particular recording on one particular transport. */
export interface RecordingRef {
  transport: "spotify" | "youtube" | "local";
  /** Spotify track ID, YouTube video ID, or a content hash for a local file. */
  id: string;
  /** Duration in ms — the cheapest sanity check that we're aligned to the right cut. */
  durationMs?: number;
  title?: string;
  artist?: string;
  album?: string;
}

// ---------------------------------------------------------------- musical content

export interface TimeSignature {
  numerator: number;
  /** 4 = quarter, 8 = eighth, etc. */
  denominator: number;
}

export interface TempoMarker {
  tick: number;
  bpm: number;
}

export interface TimeSignatureMarker {
  tick: number;
  timeSignature: TimeSignature;
}

export interface KeyMarker {
  tick: number;
  /** Tonic pitch class, 0 = C, 1 = C#/Db, ... 11 = B. */
  tonic: number;
  mode: "major" | "minor" | "dorian" | "mixolydian" | "other";
  /** 0..1 — analyzer confidence. Surface low confidence rather than asserting. */
  confidence?: number;
}

/**
 * The beat grid. This is the analyzer's most valuable and most reliable output, and it
 * is what a single averaged "BPM" number can never be: it survives tempo drift, rubato,
 * and metre changes, and it gives the cursor something to snap to.
 */
export interface BeatGrid {
  beats: Beat[];
  /** Median tempo, for display only. Never drive the cursor from this. */
  nominalBpm: number;
}

export interface Beat {
  /** Position in the recording that produced this grid, ms. */
  mediaMs: number;
  /** Which beat of the bar, 1-indexed. 1 = downbeat. */
  beatInBar: number;
  /** Bar number, 1-indexed. */
  bar: number;
  confidence?: number;
}

export interface ChordEvent {
  tick: number;
  durationTicks: number;
  /** Human-readable symbol, e.g. "Cmaj7", "F#m7b5", "N.C." */
  symbol: string;
  /** Root pitch class 0-11, or null for no-chord. */
  root: number | null;
  quality?: string;
  /** Bass pitch class if it's a slash chord. */
  bass?: number | null;
  confidence?: number;
}

export interface SectionMarker {
  tick: number;
  /** "Intro", "Verse 1", "Chorus", "Solo", "Outro" */
  label: string;
}

// ---------------------------------------------------------------- tab

export type InstrumentKind = "guitar" | "bass" | "drums" | "keys" | "vocals";

export interface TrackTuning {
  /** MIDI note per string, low to high. Standard guitar: [40,45,50,55,59,64]. */
  strings: number[];
  label?: string;
}

export interface TabNote {
  tick: number;
  durationTicks: number;
  /** 0-indexed from the lowest string. */
  string: number;
  fret: number;
  /** MIDI pitch — kept alongside the fretting so retuning can re-derive frets. */
  midi: number;
  velocity?: number;
  techniques?: TabTechnique[];
}

export type TabTechnique =
  | "hammer"
  | "pull"
  | "slide"
  | "bend"
  | "vibrato"
  | "palmMute"
  | "harmonic"
  | "ghost"
  | "dead";

/** One drum hit. `instrument` uses General MIDI percussion note numbers. */
export interface DrumHit {
  tick: number;
  /** GM percussion note, e.g. 36 kick, 38 snare, 42 closed hat. */
  instrument: number;
  velocity?: number;
  /** Accent / ghost / flam, where the analyzer can tell. */
  articulation?: "normal" | "accent" | "ghost" | "flam";
}

export interface ChartTrack {
  id: string;
  name: string;
  kind: InstrumentKind;
  tuning?: TrackTuning;
  /** Capo fret, 0 = none. */
  capo?: number;
  notes?: TabNote[];
  drums?: DrumHit[];
  /**
   * Provenance matters for trust. Show the user whether they're looking at a machine
   * guess or something a human confirmed — and let them filter to human-edited charts.
   */
  source: ContentSource;
}

export type ContentSource =
  | "analyzer"        // machine transcription, treat as a draft
  | "import"          // from a Guitar Pro / MusicXML file the user supplied
  | "user"            // hand-entered or hand-corrected
  | "community";      // shared by another user

// ---------------------------------------------------------------- lyrics

export interface LyricLine {
  /** Lyrics arrive time-stamped from LRCLIB, so these are ms in a recording, not ticks. */
  mediaMs: number;
  text: string;
  /** Per-syllable timings, if we ever get them. Mostly we won't. */
  syllables?: { mediaMs: number; text: string }[];
}

export interface Lyrics {
  lines: LyricLine[];
  source: "lrclib" | "user";
  /** LRCLIB record id, for attribution and takedown handling. */
  externalId?: string;
  /** Which recording the timings belong to. */
  recording?: RecordingRef;
}

// ---------------------------------------------------------------- the chart

export interface JammerChart {
  id: string;
  version: 1;

  title: string;
  artist: string;
  album?: string;

  ppq: number;

  tempos: TempoMarker[];
  timeSignatures: TimeSignatureMarker[];
  keys: KeyMarker[];
  sections: SectionMarker[];
  chords: ChordEvent[];
  tracks: ChartTrack[];

  /** One per recording this chart has been aligned to. */
  syncSets: SyncPointSet[];

  /**
   * The beat grid from the analysis run that produced this chart, kept for reference
   * and for re-deriving sync points. Tied to one recording.
   */
  beatGrid?: BeatGrid;

  source: ContentSource;
  createdAt: string;
  updatedAt: string;

  /**
   * For a chart imported from a notation file (Guitar Pro, MusicXML): the file's OWN
   * tick-to-millisecond mapping, from its tempo map with repeats expanded.
   *
   * alphaTab places its cursor using this native timing. When the user re-aligns the
   * chart to a recording, the highway follows the new sync points; converting through
   * this map lets the notation cursor follow the same alignment instead of drifting.
   */
  scoreTiming?: SyncPoint[];

  /** Present when the original notation file is stored alongside the chart. */
  scoreFile?: { name: string; size: number };

  /**
   * Analyzer confidence summary, 0..1 per facet. Drive UI honesty from this: a chord
   * track at 0.4 should look visibly provisional, not authoritative.
   */
  confidence?: Partial<Record<"beats" | "key" | "chords" | "tab", number>>;
}

// ---------------------------------------------------------------- tick <-> ms

/**
 * Maps chart ticks to recording milliseconds using a sync point set.
 *
 * Between two sync points we interpolate linearly. Outside the outermost points we
 * extrapolate using the nearest segment's slope. With a single point we fall back to
 * the chart's own tempo map.
 *
 * Linear interpolation between human-placed anchors beats a clever model here: it is
 * predictable, it is editable, and when it's wrong the user can see exactly which
 * anchor to drag.
 */
export class TickMap {
  private points: SyncPoint[];
  private fallbackBpm: number;
  private ppq: number;

  constructor(points: SyncPoint[], fallbackBpm = 120, ppq = PPQ) {
    this.points = [...points].sort((a, b) => a.tick - b.tick);
    this.fallbackBpm = fallbackBpm;
    this.ppq = ppq;
  }

  get isEmpty(): boolean {
    return this.points.length === 0;
  }

  tickToMs(tick: number): number {
    const p = this.points;
    if (p.length === 0) return (tick / this.ppq) * (60000 / this.fallbackBpm);
    if (p.length === 1) {
      return p[0].mediaMs + ((tick - p[0].tick) / this.ppq) * (60000 / this.fallbackBpm);
    }

    if (tick <= p[0].tick) return this.extrapolate(tick, p[0], p[1], "tick");
    const last = p.length - 1;
    if (tick >= p[last].tick) {
      return this.extrapolate(tick, p[last - 1], p[last], "tick");
    }

    const i = this.upperBound(tick, "tick");
    return this.interpolate(tick, p[i - 1], p[i], "tick");
  }

  msToTick(ms: number): number {
    const p = this.points;
    if (p.length === 0) return (ms / (60000 / this.fallbackBpm)) * this.ppq;
    if (p.length === 1) {
      return p[0].tick + ((ms - p[0].mediaMs) / (60000 / this.fallbackBpm)) * this.ppq;
    }

    if (ms <= p[0].mediaMs) return this.extrapolate(ms, p[0], p[1], "ms");
    const last = p.length - 1;
    if (ms >= p[last].mediaMs) {
      return this.extrapolate(ms, p[last - 1], p[last], "ms");
    }

    const i = this.upperBound(ms, "ms");
    return this.interpolate(ms, p[i - 1], p[i], "ms");
  }

  private upperBound(value: number, axis: "tick" | "ms"): number {
    const key = axis === "tick" ? "tick" : "mediaMs";
    let lo = 1;
    let hi = this.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.points[mid] as never as Record<string, number>)[key] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private interpolate(
    value: number,
    a: SyncPoint,
    b: SyncPoint,
    axis: "tick" | "ms",
  ): number {
    if (axis === "tick") {
      const span = b.tick - a.tick;
      if (span === 0) return a.mediaMs;
      return a.mediaMs + ((value - a.tick) / span) * (b.mediaMs - a.mediaMs);
    }
    const span = b.mediaMs - a.mediaMs;
    if (span === 0) return a.tick;
    return a.tick + ((value - a.mediaMs) / span) * (b.tick - a.tick);
  }

  private extrapolate(
    value: number,
    a: SyncPoint,
    b: SyncPoint,
    axis: "tick" | "ms",
  ): number {
    return this.interpolate(value, a, b, axis);
  }
}

/**
 * Derive sync points from a beat grid. Every Nth downbeat becomes an anchor — enough
 * to track tempo drift without producing thousands of points nobody can edit.
 */
export function syncPointsFromBeatGrid(
  grid: BeatGrid,
  ppq = PPQ,
  everyNBars = 4,
): SyncPoint[] {
  const points: SyncPoint[] = [];
  let ticksPerBar = 4 * ppq;
  let lastBar = -1;

  for (const beat of grid.beats) {
    if (beat.beatInBar !== 1) continue;
    if (beat.bar === lastBar) continue;
    if ((beat.bar - 1) % everyNBars !== 0) continue;
    lastBar = beat.bar;
    points.push({
      mediaMs: beat.mediaMs,
      tick: (beat.bar - 1) * ticksPerBar,
      confirmed: false,
    });
  }
  return points;
}

export const PITCH_CLASS_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

export function formatKey(key: KeyMarker): string {
  return `${PITCH_CLASS_NAMES[key.tonic % 12]} ${key.mode}`;
}

export function formatTimeSignature(ts: TimeSignature): string {
  return `${ts.numerator}/${ts.denominator}`;
}
