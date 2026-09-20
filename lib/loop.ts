/**
 * Section looping.
 *
 * WHY BAR SNAPPING IS THE WHOLE FEATURE
 * -------------------------------------
 * A loop set by eye to arbitrary millisecond boundaries is nearly useless for
 * practice: it clips the downbeat, or leaves a fragment of the previous bar, and every
 * repetition lands somewhere slightly different. What you want is "loop bars 17 to 24",
 * and you want the loop point to land exactly on the downbeat.
 *
 * We have a beat grid, so we can snap. That turns a fiddly drag into two clicks.
 *
 * THE SEEK-BACK PROBLEM
 * ---------------------
 * Looping means seeking backwards the moment the playhead passes the end. Two things
 * make that harder than it sounds:
 *
 *  1. Every transport has seek latency — tens of ms locally, hundreds over Spotify
 *     Connect. If we wait until position > end, we hear past the end before the jump.
 *     So we fire the seek *early*, by a lead time, and let the seek land on the start.
 *
 *  2. A seek is not instant, and our clock keeps free-running meanwhile. Without a
 *     guard we'd detect "past the end" again on the next frame and fire a second seek,
 *     producing a stutter. Hence the cooldown.
 */

import type { Beat } from "./types.ts";

export interface LoopRegion {
  startMs: number;
  endMs: number;
  /** Bars, when the region was snapped to the grid. For display. */
  startBar?: number;
  endBar?: number;
  enabled: boolean;
}

/** How early to fire the wrap seek, covering transport latency. */
export const LOOP_LEAD_MS = 120;
/** Ignore further wrap triggers for this long after firing one. */
export const LOOP_COOLDOWN_MS = 400;

/**
 * Should the loop wrap right now?
 *
 * `lastWrapAt` is a wall-clock timestamp of the previous wrap, used for the cooldown.
 * Returns the position to seek to, or null.
 */
export function loopWrapTarget(
  region: LoopRegion | null,
  positionMs: number,
  nowWallMs: number,
  lastWrapAt: number,
): number | null {
  if (!region?.enabled) return null;
  if (region.endMs <= region.startMs) return null;
  if (nowWallMs - lastWrapAt < LOOP_COOLDOWN_MS) return null;

  // Wrap when approaching the end.
  if (positionMs >= region.endMs - LOOP_LEAD_MS) return region.startMs;

  // Also wrap if the user seeked outside the region entirely — otherwise pressing play
  // from elsewhere silently ignores the loop, which reads as the loop being broken.
  if (positionMs < region.startMs - 1000) return region.startMs;

  return null;
}

/** Nearest downbeat to a position. Falls back to the position itself with no grid. */
export function snapToBar(
  beats: Beat[] | undefined,
  positionMs: number,
): { mediaMs: number; bar?: number } {
  if (!beats?.length) return { mediaMs: positionMs };

  let best: Beat | null = null;
  let bestDist = Infinity;

  for (const beat of beats) {
    if (beat.beatInBar !== 1) continue;
    const dist = Math.abs(beat.mediaMs - positionMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = beat;
    }
  }

  if (!best) return { mediaMs: positionMs };
  return { mediaMs: best.mediaMs, bar: best.bar };
}

/** Nearest beat (not just downbeats), for finer loop points. */
export function snapToBeat(
  beats: Beat[] | undefined,
  positionMs: number,
): { mediaMs: number; bar?: number } {
  if (!beats?.length) return { mediaMs: positionMs };

  let best: Beat | null = null;
  let bestDist = Infinity;
  for (const beat of beats) {
    const dist = Math.abs(beat.mediaMs - positionMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = beat;
    }
  }
  if (!best) return { mediaMs: positionMs };
  return { mediaMs: best.mediaMs, bar: best.bar };
}

/** Region covering whole bars [startBar, endBar], inclusive of startBar's downbeat. */
export function regionForBars(
  beats: Beat[] | undefined,
  startBar: number,
  endBar: number,
): LoopRegion | null {
  if (!beats?.length) return null;

  const downbeat = (bar: number) => beats.find((b) => b.bar === bar && b.beatInBar === 1);

  const start = downbeat(startBar);
  // The loop ends where the bar AFTER the last one begins, so the final bar plays whole.
  const end = downbeat(endBar + 1);

  if (!start) return null;

  return {
    startMs: start.mediaMs,
    // No bar after the last one (end of song): run to the final beat plus its length.
    endMs: end?.mediaMs ?? beats[beats.length - 1].mediaMs + estimateBeatMs(beats),
    startBar,
    endBar,
    enabled: true,
  };
}

function estimateBeatMs(beats: Beat[]): number {
  if (beats.length < 2) return 500;
  const deltas: number[] = [];
  for (let i = 1; i < Math.min(beats.length, 33); i++) {
    deltas.push(beats[i].mediaMs - beats[i - 1].mediaMs);
  }
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] || 500;
}

/** Shift a loop by whole bars — "now do the next eight". */
export function nudgeRegionByBars(
  region: LoopRegion,
  beats: Beat[] | undefined,
  deltaBars: number,
): LoopRegion {
  if (!beats?.length || region.startBar === undefined || region.endBar === undefined) {
    // No grid: shift by the region's own length.
    const span = region.endMs - region.startMs;
    return {
      ...region,
      startMs: Math.max(0, region.startMs + span * deltaBars),
      endMs: Math.max(span, region.endMs + span * deltaBars),
    };
  }

  const maxBar = beats[beats.length - 1].bar;
  const span = region.endBar - region.startBar;
  const nextStart = Math.max(1, Math.min(maxBar - span, region.startBar + deltaBars));

  return regionForBars(beats, nextStart, nextStart + span) ?? region;
}

export function formatRegion(region: LoopRegion): string {
  if (region.startBar !== undefined && region.endBar !== undefined) {
    return region.startBar === region.endBar
      ? `bar ${region.startBar}`
      : `bars ${region.startBar}–${region.endBar}`;
  }
  return `${fmt(region.startMs)}–${fmt(region.endMs)}`;
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
