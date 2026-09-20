/**
 * LRCLIB client — free, crowd-sourced, time-stamped lyrics. No API key, no registration.
 *
 * This is the one lyrics source that is both legitimate and actually usable:
 *   - Genius has an API but deliberately withholds lyric bodies.
 *   - Musixmatch's free tier returns 30% of a song.
 *   - Everything else is scraping.
 *
 * LRCLIB gives `[mm:ss.xx]`-prefixed lines, which is already the shape we need.
 *
 * BEING A GOOD CITIZEN — this is a free service run at someone's own expense:
 *   - Send a real User-Agent identifying the app and a contact URL. They ask for this.
 *   - Honour 429 and its Retry-After header.
 *   - Cache. Never re-fetch the same track twice in a session.
 *
 * Matching: `/api/get` requires the duration to be within ±2s of the stored record, so
 * always pass it. When the exact match fails, `/api/search` is the fallback, and we
 * re-rank its results by duration ourselves because it doesn't.
 */

import type { Lyrics, LyricLine } from "./types";

const BASE = "https://lrclib.net/api";

const USER_AGENT =
  "Jammer/0.1.0 (https://github.com/yourname/jammer)";

export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

const cache = new Map<string, Lyrics | null>();

function cacheKey(track: string, artist: string, durationMs?: number): string {
  return `${artist}::${track}::${Math.round((durationMs ?? 0) / 1000)}`;
}

async function request<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      // Browsers forbid setting User-Agent, so LRCLIB accepts these alternates.
      "Lrclib-Client": USER_AGENT,
      "X-User-Agent": USER_AGENT,
    },
  });

  if (res.status === 404) return null;

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
    throw new LyricsRateLimit(retryAfter);
  }

  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json() as Promise<T>;
}

export class LyricsRateLimit extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`LRCLIB rate limited; retry after ${retryAfterSeconds}s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Parse an LRC body into timed lines.
 *
 * Handles the wrinkles real LRC files have:
 *  - metadata tags (`[ar:...]`, `[length:...]`) which must be ignored, not parsed
 *  - multiple timestamps on one line (`[00:12.00][01:30.00]same words`)
 *  - fractions of 1, 2 or 3 digits, meaning tenths, centiseconds and milliseconds
 *    respectively. Accepting only 2-3 digits silently drops every `[01:02.5]` line —
 *    not a parse error you'd notice, just lyrics quietly missing.
 *  - minute values above 99 on long tracks
 */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const timeTag = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const raw of lrc.split(/\r?\n/)) {
    timeTag.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = timeTag.exec(raw)) !== null) {
      const [, mm, ss, frac] = match;
      let ms = Number(mm) * 60_000 + Number(ss) * 1000;
      if (frac) {
        // 1 digit = tenths, 2 = centiseconds, 3 = milliseconds.
        const scale = frac.length === 1 ? 100 : frac.length === 2 ? 10 : 1;
        ms += Number(frac) * scale;
      }
      stamps.push(ms);
      lastIndex = match.index + match[0].length;
    }

    if (stamps.length === 0) continue;
    const text = raw.slice(lastIndex).trim();
    for (const mediaMs of stamps) {
      lines.push({ mediaMs, text });
    }
  }

  return lines.sort((a, b) => a.mediaMs - b.mediaMs);
}

export async function fetchLyrics(
  trackName: string,
  artistName: string,
  albumName?: string,
  durationMs?: number,
): Promise<Lyrics | null> {
  const key = cacheKey(trackName, artistName, durationMs);
  if (cache.has(key)) return cache.get(key) ?? null;

  let record: LrclibRecord | null = null;

  // Exact match first — this is the path that gets correct timings.
  const params = new URLSearchParams({
    track_name: trackName,
    artist_name: artistName,
  });
  if (albumName) params.set("album_name", albumName);
  if (durationMs) params.set("duration", String(Math.round(durationMs / 1000)));

  try {
    record = await request<LrclibRecord>(`/get?${params}`);
  } catch (err) {
    if (err instanceof LyricsRateLimit) throw err;
    record = null;
  }

  // Fallback: fuzzy search, then re-rank by duration ourselves.
  if (!record) {
    const search = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName,
    });
    const results =
      (await request<LrclibRecord[]>(`/search?${search}`).catch(() => null)) ?? [];

    const scored = results
      .filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental)
      .map((r) => ({
        r,
        // Prefer synced lyrics, then closest duration.
        score:
          (r.syncedLyrics ? 0 : 10_000) +
          (durationMs ? Math.abs(r.duration * 1000 - durationMs) : 0),
      }))
      .sort((a, b) => a.score - b.score);

    record = scored[0]?.r ?? null;
  }

  if (!record) {
    cache.set(key, null);
    return null;
  }

  if (record.instrumental) {
    const instrumental: Lyrics = {
      lines: [],
      source: "lrclib",
      externalId: String(record.id),
    };
    cache.set(key, instrumental);
    return instrumental;
  }

  const lines = record.syncedLyrics
    ? parseLrc(record.syncedLyrics)
    : // Unsynced: keep the words but give them no timings. The UI should show them as
      // a static block rather than pretending to scroll them.
      (record.plainLyrics ?? "")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((text) => ({ mediaMs: -1, text }));

  const lyrics: Lyrics = {
    lines,
    source: "lrclib",
    externalId: String(record.id),
  };

  cache.set(key, lyrics);
  return lyrics;
}

/** Index of the line active at `mediaMs`, or -1. Binary search; called every frame. */
export function activeLineIndex(lines: LyricLine[], mediaMs: number): number {
  if (lines.length === 0 || lines[0].mediaMs < 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].mediaMs <= mediaMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function hasSyncedTimings(lyrics: Lyrics | null): boolean {
  return !!lyrics && lyrics.lines.length > 0 && lyrics.lines[0].mediaMs >= 0;
}
