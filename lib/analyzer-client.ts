/**
 * Client for the analyzer service.
 *
 * Analysis takes minutes on CPU, so this polls a job rather than awaiting a response.
 * The `onProgress` callback exists so the UI can say something more useful than a
 * spinner — "separating stems" for three minutes is tolerable, an unexplained spinner
 * for three minutes is not.
 */

import type {
  BeatGrid,
  ChordEvent,
  JammerChart,
  KeyMarker,
  TabNote,
  TimeSignature,
} from "./types.ts";
import { PPQ, syncPointsFromBeatGrid } from "./types.ts";

const BASE =
  process.env.NEXT_PUBLIC_ANALYZER_URL ?? "http://127.0.0.1:8000";

export interface AnalyzerResult {
  durationMs: number;
  beatGrid: BeatGrid;
  timeSignature: TimeSignature;
  key: { tonic: number; mode: string; confidence: number } | null;
  chords: {
    tick: number;
    duration_ticks: number;
    symbol: string;
    root: number | null;
    quality: string;
    confidence: number;
  }[];
  tracks: Record<
    string,
    {
      tick: number;
      duration_ticks: number;
      midi: number;
      velocity: number;
      string: number | null;
      fret: number | null;
    }[]
  >;
  confidence: { beats: number; key: number; chords: number };
  warnings: string[];
}

export interface JobState {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  stage: string;
  progress: number;
  result: AnalyzerResult | null;
  error: string | null;
}

export async function analyzerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function submitAnalysis(
  file: File,
  opts: { stems?: boolean; tab?: boolean } = {},
): Promise<string> {
  const body = new FormData();
  body.append("file", file);

  const params = new URLSearchParams({
    stems: String(opts.stems ?? true),
    tab: String(opts.tab ?? true),
  });

  const res = await fetch(`${BASE}/analyze?${params}`, { method: "POST", body });
  if (!res.ok) {
    throw new Error(`Analyzer rejected the upload: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).jobId as string;
}

export async function pollJob(
  jobId: string,
  onProgress?: (state: JobState) => void,
  intervalMs = 2000,
  signal?: AbortSignal,
): Promise<AnalyzerResult> {
  for (;;) {
    if (signal?.aborted) throw new Error("Analysis cancelled.");

    const res = await fetch(`${BASE}/jobs/${jobId}`);
    if (!res.ok) throw new Error(`Job lookup failed: ${res.status}`);

    const state = (await res.json()) as JobState;
    onProgress?.(state);

    if (state.status === "done" && state.result) return state.result;
    if (state.status === "failed") {
      throw new Error(state.error ?? "Analysis failed for an unknown reason.");
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Convert an analyzer result into a JammerChart.
 *
 * The important step is generating sync points from the beat grid: that's what binds
 * the (tick-based) chart to this particular (millisecond-based) recording, and what
 * lets the same chart later be re-aligned to a different master.
 */
export function chartFromAnalysis(
  result: AnalyzerResult,
  meta: { title: string; artist: string; album?: string; recordingId: string },
): JammerChart {
  const nowIso = new Date().toISOString();

  const keys: KeyMarker[] = result.key
    ? [
        {
          tick: 0,
          tonic: result.key.tonic,
          mode: result.key.mode === "minor" ? "minor" : "major",
          confidence: result.key.confidence,
        },
      ]
    : [];

  const chords: ChordEvent[] = result.chords.map((c) => ({
    tick: c.tick,
    durationTicks: c.duration_ticks,
    symbol: c.symbol,
    root: c.root,
    quality: c.quality,
    confidence: c.confidence,
  }));

  const tracks = Object.entries(result.tracks).map(([name, notes]) => ({
    id: name,
    name: name[0].toUpperCase() + name.slice(1),
    kind: (name === "bass" ? "bass" : name === "drums" ? "drums" : "guitar") as
      | "bass"
      | "drums"
      | "guitar",
    tuning: {
      strings:
        name === "bass" ? [28, 33, 38, 43] : [40, 45, 50, 55, 59, 64],
    },
    notes: notes
      .filter((n) => n.string !== null && n.fret !== null)
      .map(
        (n): TabNote => ({
          tick: n.tick,
          durationTicks: n.duration_ticks,
          string: n.string as number,
          fret: n.fret as number,
          midi: n.midi,
          velocity: n.velocity,
        }),
      ),
    source: "analyzer" as const,
  }));

  return {
    id: crypto.randomUUID(),
    version: 1,
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    ppq: PPQ,
    tempos: [{ tick: 0, bpm: result.beatGrid.nominalBpm }],
    timeSignatures: [{ tick: 0, timeSignature: result.timeSignature }],
    keys,
    sections: [],
    chords,
    tracks,
    beatGrid: result.beatGrid,
    syncSets: [
      {
        id: crypto.randomUUID(),
        recording: { transport: "local", id: meta.recordingId },
        points: syncPointsFromBeatGrid(result.beatGrid, PPQ, 4),
        updatedAt: nowIso,
      },
    ],
    source: "analyzer",
    createdAt: nowIso,
    updatedAt: nowIso,
    confidence: {
      beats: result.confidence.beats,
      key: result.confidence.key,
      chords: result.confidence.chords,
    },
  };
}

/** Human-readable progress label. A three-minute spinner needs words. */
export function stageLabel(state: JobState): string {
  switch (state.status) {
    case "queued":
      return "Waiting for a worker…";
    case "running":
      return state.stage === "analysing"
        ? "Analysing — separating stems can take a few minutes on CPU"
        : state.stage;
    case "done":
      return "Done";
    case "failed":
      return state.error ?? "Failed";
  }
}
