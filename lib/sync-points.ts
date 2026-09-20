/**
 * Sync-point logic, kept out of the editor component.
 *
 * These are pure functions over anchors — no React, no DOM — so they can be tested
 * directly and reused by anything that needs to reason about an alignment (an
 * importer, a server-side validator, a future "suggest anchors" feature).
 */

import { PPQ, TickMap, type SyncPoint } from "./types.ts";

/**
 * Catch the two mistakes that produce a lurching cursor, and say which anchor is at
 * fault.
 *
 * A bad alignment is very hard to diagnose by feel: the cursor drifts or jumps, but
 * nothing tells you *which* of twenty anchors is wrong. These two checks catch
 * essentially every mis-set anchor in practice:
 *
 *   1. Non-monotonic — an anchor earlier in the recording than the one before it.
 *      Time would run backwards through that segment.
 *   2. Implausible tempo — the anchors imply a tempo outside any real music.
 *      Almost always a bar number typo.
 */
export function validateSyncPoints(
  points: SyncPoint[],
  ticksPerBar: number,
): string[] {
  const problems: string[] = [];
  const sorted = [...points].sort((a, b) => a.tick - b.tick);
  const barOf = (tick: number) => Math.round(tick / ticksPerBar) + 1;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].mediaMs <= sorted[i - 1].mediaMs) {
      problems.push(
        `Anchor at bar ${barOf(sorted[i].tick)} is not after the one before it — ` +
          `the chart would run backwards there.`,
      );
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const bars = (sorted[i].tick - sorted[i - 1].tick) / ticksPerBar;
    const seconds = (sorted[i].mediaMs - sorted[i - 1].mediaMs) / 1000;
    if (bars <= 0 || seconds <= 0) continue;

    const bpm = (bars * 4 * 60) / seconds;
    if (bpm < 30 || bpm > 300) {
      problems.push(
        `Anchors near bar ${barOf(sorted[i].tick)} imply ${Math.round(bpm)} BPM, ` +
          `which is probably a mis-set anchor.`,
      );
    }
  }

  // Three is enough to act on; a wall of warnings just gets dismissed.
  return problems.slice(0, 3);
}

/** Tempo implied by a run of taps, assuming one tap per bar of 4/4. */
export function impliedBpmFromTaps(taps: number[], beatsPerBar = 4): number | null {
  if (taps.length < 2) return null;

  const deltas: number[] = [];
  for (let i = 1; i < taps.length; i++) deltas.push(taps[i] - taps[i - 1]);

  // Median, not mean: one fumbled tap shouldn't move the estimate.
  const median = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)];
  if (median <= 0) return null;

  return Math.round((60_000 / median) * beatsPerBar);
}

/** Shift every anchor by a constant — the "nudge" operation. */
export function offsetSyncPoints(points: SyncPoint[], deltaMs: number): SyncPoint[] {
  return points.map((p) => ({ ...p, mediaMs: p.mediaMs + deltaMs }));
}

/** Build anchors from a run of taps, one per bar starting at `startBar`. */
export function syncPointsFromTaps(
  taps: number[],
  startBar: number,
  ticksPerBar: number,
): SyncPoint[] {
  return taps.map((mediaMs, i) => ({
    mediaMs,
    tick: (startBar - 1 + i) * ticksPerBar,
    confirmed: true,
  }));
}

/** Preview a point set without committing — used for the live nudge. */
export function previewMap(points: SyncPoint[], bpm = 120): TickMap {
  return new TickMap(points, bpm, PPQ);
}
