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
