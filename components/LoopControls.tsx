"use client";

/**
 * Loop controls.
 *
 * Designed around how you actually practise: you hear a passage you can't play, and
 * you want to loop it *now*, without pausing to fiddle with handles. So:
 *
 *   - "Set A" and "Set B" capture the live playhead, snapped to the nearest downbeat.
 *   - Bar arrows move the loop a whole section at a time: "now the next eight".
 *   - Keyboard: A, B, L to toggle. No pointer accuracy required mid-song.
 *
 * Snapping is what makes this useful rather than fiddly. A loop set by eye clips the
 * downbeat and lands differently every repetition; snapped to the grid it's the same
 * eight bars every time.
 */

import { useCallback, useEffect, useState } from "react";
import {
  formatRegion,
  nudgeRegionByBars,
  regionForBars,
  snapToBar,
  type LoopRegion,
} from "../lib/loop";
import type { SyncEngine } from "../lib/sync-engine";
import type { Beat } from "../lib/types";

export interface LoopControlsProps {
  engine: SyncEngine;
  beats?: Beat[];
  /** Count-in clicks before the loop restarts. Needs a beat grid. */
  countIn?: boolean;
  onCountInChange?: (on: boolean) => void;
}

export function LoopControls({
  engine,
  beats,
  countIn = false,
  onCountInChange,
}: LoopControlsProps) {
  const [region, setRegion] = useState<LoopRegion | null>(null);
  const [pendingA, setPendingA] = useState<number | null>(null);

  useEffect(() => engine.onLoopChange(setRegion), [engine]);

  const hasGrid = !!beats?.length;

  const setA = useCallback(() => {
    const snapped = snapToBar(beats, engine.clock.positionForDisplay());
    setPendingA(snapped.mediaMs);

    // If B is already past A, form the region immediately — don't make the user
    // re-set both ends.
    if (region && region.endMs > snapped.mediaMs) {
      engine.setLoop({
        ...region,
        startMs: snapped.mediaMs,
        startBar: snapped.bar,
        enabled: true,
      });
      setPendingA(null);
    }
  }, [beats, engine, region]);

  const setB = useCallback(() => {
    const snapped = snapToBar(beats, engine.clock.positionForDisplay());
    const startMs = pendingA ?? region?.startMs ?? 0;
    const startBar =
      pendingA !== null ? snapToBar(beats, pendingA).bar : region?.startBar;

    if (snapped.mediaMs <= startMs) return;

    engine.setLoop({
      startMs,
      endMs: snapped.mediaMs,
      startBar,
      // B marks where the loop ends, i.e. the downbeat *after* the last bar played.
      endBar: snapped.bar !== undefined ? snapped.bar - 1 : undefined,
      enabled: true,
    });
    setPendingA(null);
  }, [beats, engine, pendingA, region]);

  const toggle = useCallback(() => {
    if (!region) return;
    engine.setLoop({ ...region, enabled: !region.enabled });
  }, [engine, region]);

  const clear = useCallback(() => {
    engine.setLoop(null);
    setPendingA(null);
  }, [engine]);

  const nudge = useCallback(
    (bars: number) => {
      if (!region) return;
      engine.setLoop(nudgeRegionByBars(region, beats, bars));
    },
    [engine, region, beats],
  );

  const resize = useCallback(
    (bars: number) => {
      if (!region || region.startBar === undefined || region.endBar === undefined) return;
      const nextEnd = Math.max(region.startBar, region.endBar + bars);
      const next = regionForBars(beats, region.startBar, nextEnd);
      if (next) engine.setLoop(next);
    },
    [engine, region, beats],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === "KeyA") {
        e.preventDefault();
        setA();
      } else if (e.code === "KeyB") {
        e.preventDefault();
        setB();
      } else if (e.code === "KeyL") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setA, setB, toggle]);

  return (
    <div className={`loop ${region?.enabled ? "on" : ""}`}>
      <button onClick={setA} title="Set loop start at the playhead (A)">
        A
      </button>
      <button onClick={setB} title="Set loop end at the playhead (B)">
        B
      </button>

      {region ? (
        <>
          <button
            className={region.enabled ? "active" : ""}
            onClick={toggle}
            title="Toggle looping (L)"
          >
            ⟲ {formatRegion(region)}
          </button>

          {region.startBar !== undefined && (
            <span className="loop-nudge">
              <button onClick={() => nudge(-(region.endBar! - region.startBar! + 1))} title="Previous section">
                ◀
              </button>
              <button onClick={() => nudge(region.endBar! - region.startBar! + 1)} title="Next section">
                ▶
              </button>
              <button onClick={() => resize(-1)} title="One bar shorter">
                −
              </button>
              <button onClick={() => resize(1)} title="One bar longer">
                +
              </button>
            </span>
          )}

          <button onClick={clear} title="Clear the loop">
            ×
          </button>
        </>
      ) : (
        <span className="muted small">
          {pendingA !== null ? "A set — now set B" : hasGrid ? "Loop" : "Loop (no grid)"}
        </span>
      )}

      {onCountInChange && hasGrid && (
        <label className="loop-countin" title="One bar of clicks before the loop restarts">
          <input
            type="checkbox"
            checked={countIn}
            onChange={(e) => onCountInChange(e.target.checked)}
          />
          Count-in
        </label>
      )}
    </div>
  );
}
