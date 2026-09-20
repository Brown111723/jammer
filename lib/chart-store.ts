/**
 * Chart persistence.
 *
 * localStorage for now, behind an async interface so swapping in Postgres later is a
 * change to this file alone rather than to every caller.
 *
 * WHY SYNC SETS ARE STORED SEPARATELY FROM CHARTS
 * -----------------------------------------------
 * A chart is about a *song*. A sync set is about one *recording* of it. Storing them
 * together would mean copying the whole chart each time you align it to another
 * master — and would quietly lose the connection between those copies, which is the
 * thing that makes the chart worth having.
 *
 * Keyed separately, aligning "Black Dog" to the 2007 remaster adds one small record
 * and the chart itself is untouched. That is also exactly the shape you'd want if these
 * charts were later shared between users.
 */

import type { JammerChart, RecordingRef, SyncPoint, SyncPointSet } from "./types";

const CHART_KEY = "jammer.charts";
const SYNC_KEY = "jammer.syncsets";
const LINK_KEY = "jammer.links";

/** recordingKey -> chartId */
type LinkMap = Record<string, string>;

export function recordingKey(ref: RecordingRef): string {
  return `${ref.transport}:${ref.id}`;
}

function read<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // QuotaExceededError is realistic here: a few dozen charts with dense note data
    // will fill the 5MB budget. Fail loudly rather than silently losing a chart the
    // user spent time correcting.
    console.error(
      "[jammer] Could not save — browser storage is full. " +
        "Export charts you want to keep before adding more.",
      err,
    );
    throw err;
  }
}

// ---------------------------------------------------------------- charts

export async function saveChart(chart: JammerChart): Promise<void> {
  const charts = read<Record<string, JammerChart>>(CHART_KEY, {});
  charts[chart.id] = { ...chart, updatedAt: new Date().toISOString() };
  write(CHART_KEY, charts);
}

export async function loadChart(id: string): Promise<JammerChart | null> {
  return read<Record<string, JammerChart>>(CHART_KEY, {})[id] ?? null;
}

export async function listCharts(): Promise<JammerChart[]> {
  return Object.values(read<Record<string, JammerChart>>(CHART_KEY, {})).sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  );
}

export async function deleteChart(id: string): Promise<void> {
  const charts = read<Record<string, JammerChart>>(CHART_KEY, {});
  delete charts[id];
  write(CHART_KEY, charts);

  // Drop this chart's sync sets and links too, or they leak forever.
  const sets = read<Record<string, SyncPointSet[]>>(SYNC_KEY, {});
  for (const key of Object.keys(sets)) {
    sets[key] = sets[key].filter((s) => !s.id.startsWith(`${id}:`));
    if (sets[key].length === 0) delete sets[key];
  }
  write(SYNC_KEY, sets);

  const links = read<LinkMap>(LINK_KEY, {});
  for (const [key, chartId] of Object.entries(links)) {
    if (chartId === id) delete links[key];
  }
  write(LINK_KEY, links);
}

// ---------------------------------------------------------------- sync sets

export async function saveSyncPoints(
  chartId: string,
  recording: RecordingRef,
  points: SyncPoint[],
  contributor?: string,
): Promise<void> {
  const key = recordingKey(recording);
  const all = read<Record<string, SyncPointSet[]>>(SYNC_KEY, {});
  const forRecording = all[key] ?? [];

  const id = `${chartId}:${key}`;
  const set: SyncPointSet = {
    id,
    recording,
    points: [...points].sort((a, b) => a.tick - b.tick),
    contributor,
    updatedAt: new Date().toISOString(),
  };

  const existing = forRecording.findIndex((s) => s.id === id);
  if (existing >= 0) forRecording[existing] = set;
  else forRecording.push(set);

  all[key] = forRecording;
  write(SYNC_KEY, all);

  // Remember which chart this recording uses, so opening the track again just works.
  const links = read<LinkMap>(LINK_KEY, {});
  links[key] = chartId;
  write(LINK_KEY, links);
}

export async function loadSyncPoints(
  chartId: string,
  recording: RecordingRef,
): Promise<SyncPoint[] | null> {
  const key = recordingKey(recording);
  const all = read<Record<string, SyncPointSet[]>>(SYNC_KEY, {});
  const set = (all[key] ?? []).find((s) => s.id === `${chartId}:${key}`);
  return set?.points ?? null;
}

/** Which chart, if any, this recording has been aligned to before. */
export async function chartForRecording(
  recording: RecordingRef,
): Promise<JammerChart | null> {
  const links = read<LinkMap>(LINK_KEY, {});
  const chartId = links[recordingKey(recording)];
  return chartId ? loadChart(chartId) : null;
}

/** Every recording a given chart has been aligned to. */
export async function recordingsForChart(chartId: string): Promise<RecordingRef[]> {
  const all = read<Record<string, SyncPointSet[]>>(SYNC_KEY, {});
  const out: RecordingRef[] = [];
  for (const sets of Object.values(all)) {
    for (const set of sets) {
      if (set.id.startsWith(`${chartId}:`)) out.push(set.recording);
    }
  }
  return out;
}

// ---------------------------------------------------------------- portability

/**
 * Export everything as one JSON file.
 *
 * Worth having early: browser storage is not a safe home for work someone has spent
 * an evening correcting, and "clear site data" is one misclick away.
 */
export async function exportAll(): Promise<Blob> {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    charts: read<Record<string, JammerChart>>(CHART_KEY, {}),
    syncSets: read<Record<string, SyncPointSet[]>>(SYNC_KEY, {}),
    links: read<LinkMap>(LINK_KEY, {}),
  };
  return new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
}

export async function importAll(file: File): Promise<{ charts: number }> {
  const text = await file.text();
  const payload = JSON.parse(text) as {
    version?: number;
    charts?: Record<string, JammerChart>;
    syncSets?: Record<string, SyncPointSet[]>;
    links?: LinkMap;
  };

  if (payload.version !== 1) {
    throw new Error(
      `Unsupported export version ${payload.version ?? "(missing)"}. ` +
        "This file was written by a different version of Jammer.",
    );
  }

  // Merge rather than replace — importing a friend's chart shouldn't wipe your own.
  const charts = { ...read<Record<string, JammerChart>>(CHART_KEY, {}), ...payload.charts };
  write(CHART_KEY, charts);

  const sets = read<Record<string, SyncPointSet[]>>(SYNC_KEY, {});
  for (const [key, incoming] of Object.entries(payload.syncSets ?? {})) {
    const existing = sets[key] ?? [];
    const byId = new Map(existing.map((s) => [s.id, s]));
    for (const set of incoming) byId.set(set.id, set);
    sets[key] = [...byId.values()];
  }
  write(SYNC_KEY, sets);

  write(LINK_KEY, { ...read<LinkMap>(LINK_KEY, {}), ...payload.links });

  return { charts: Object.keys(payload.charts ?? {}).length };
}

// ---------------------------------------------------------------- matching

/**
 * Find a chart for a song by its metadata, regardless of which recording produced it.
 *
 * This is what makes analysis worth doing once. The chart format is deliberately
 * recording-independent — musical time in ticks, with a per-recording sync set — so a
 * chart built from your local copy of a song is equally valid against the YouTube
 * upload, the Spotify track and the remaster. It just needs to be *found*.
 *
 * Matching is on normalised title and artist, with duration as a tiebreaker rather
 * than a gate: the same song on YouTube is routinely a few seconds longer than the
 * album cut (intros, applause, an outro that fades later), so a strict duration match
 * would reject correct hits. Alignment is the sync editor's job, not the matcher's.
 */
export function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    // Strip the noise that YouTube titles carry and album metadata doesn't.
    .replace(
      /[([]\s*(official\s*)?(music\s*)?(lyric\s*)?(video|audio|visualizer|hd|4k|remaster(ed)?(\s*\d{4})?|explicit|clean|mv|live|acoustic|demo|version)\s*[)\]]/g,
      "",
    )
    .replace(/\s*[-–—]\s*topic$/, "")
    .replace(/feat\.?|ft\.?|featuring/g, "")
    // Punctuation and spacing vary constantly between sources.
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

export interface ChartMatch {
  chart: JammerChart;
  /** 0..1 — how confident the match is. */
  score: number;
  /** True when this chart has already been aligned to this exact recording. */
  exact: boolean;
}

export async function findChartForSong(
  title: string,
  artist: string,
  recording?: RecordingRef,
): Promise<ChartMatch | null> {
  // An exact prior alignment always wins — it means someone already did this.
  if (recording) {
    const linked = await chartForRecording(recording);
    if (linked) return { chart: linked, score: 1, exact: true };
  }

  const wantTitle = normaliseForMatch(title);
  const wantArtist = normaliseForMatch(artist);
  if (!wantTitle) return null;

  let best: ChartMatch | null = null;

  for (const chart of await listCharts()) {
    const haveTitle = normaliseForMatch(chart.title);
    const haveArtist = normaliseForMatch(chart.artist);
    if (!haveTitle) continue;

    let score = 0;
    if (haveTitle === wantTitle) score += 0.7;
    else if (haveTitle.includes(wantTitle) || wantTitle.includes(haveTitle)) score += 0.45;
    else continue; // Title has to be in the ballpark or it's a different song.

    if (wantArtist && haveArtist) {
      if (haveArtist === wantArtist) score += 0.3;
      else if (haveArtist.includes(wantArtist) || wantArtist.includes(haveArtist)) {
        score += 0.2;
      }
    } else {
      // No artist to compare — a title-only match is weaker but still useful.
      score += 0.1;
    }

    if (!best || score > best.score) best = { chart, score, exact: false };
  }

  // Below this, it's guessing. A wrong chart is worse than none: the cursor runs over
  // notes that were never in the song.
  return best && best.score >= 0.55 ? best : null;
}
