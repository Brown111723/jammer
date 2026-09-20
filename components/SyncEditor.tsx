"use client";

/**
 * The sync-point editor.
 *
 * This is the UI for the feature that makes Jammer structurally different from
 * Songsterr: one chart, aligned to any number of recordings.
 *
 * A CONSTRAINT THAT SHAPES THE DESIGN
 * -----------------------------------
 * Every alignment tool you've seen draws a waveform and lets you drag markers onto the
 * transients. We cannot do that. Spotify and YouTube audio is DRM-protected — there is
 * no waveform to draw, because there are no samples to read. (For local files we *could*
 * draw one, but building the primary workflow around a view that only exists in one of
 * three transports would be a mistake.)
 *
 * So the primary workflow is **tap-to-align**: play the song and tap on each downbeat.
 * That works identically on every transport, and it's how a musician would naturally
 * find the beat anyway. It's arguably better than dragging markers on a waveform, since
 * you're aligning to what you *hear* rather than to what the peaks look like.
 *
 * THREE WAYS TO ALIGN, cheapest first
 * -----------------------------------
 *   1. Nudge      — one offset for the whole song. Fixes a different lead-in. Seconds.
 *   2. Two-point  — offset plus linear stretch. Fixes a different master or sample rate.
 *   3. Tap        — an anchor per bar. Tracks a live performance that drifts.
 *
 * Most songs need only (1). Offering (3) first would make a five-second job feel like a
 * chore, so the UI is ordered by effort.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncEngine } from "../lib/sync-engine";
import {
  impliedBpmFromTaps,
  offsetSyncPoints,
  syncPointsFromTaps,
  validateSyncPoints,
} from "../lib/sync-points";
import { PPQ, type SyncPoint } from "../lib/types";

export interface SyncEditorProps {
  engine: SyncEngine;
  points: SyncPoint[];
  /** Ticks per bar, for labelling anchors as bar numbers. */
  ticksPerBar?: number;
  onChange: (points: SyncPoint[]) => void;
  onClose?: () => void;
}

export function SyncEditor({
  engine,
  points,
  ticksPerBar = 4 * PPQ,
  onChange,
  onClose,
}: SyncEditorProps) {
  const [mode, setMode] = useState<"nudge" | "twoPoint" | "tap">("nudge");
  const [nudgeMs, setNudgeMs] = useState(0);
  const [tapping, setTapping] = useState(false);
  const [taps, setTaps] = useState<number[]>([]);
  const [tapStartBar, setTapStartBar] = useState(1);
  const [anchorA, setAnchorA] = useState<SyncPoint | null>(null);

  const positionRef = useRef(0);
  const readoutRef = useRef<HTMLSpanElement>(null);

  // Live position readout, refs only.
  useEffect(() => {
    return engine.onFrame((positionMs) => {
      positionRef.current = positionMs;
      if (readoutRef.current) {
        readoutRef.current.textContent = fmt(positionMs);
      }
    });
  }, [engine]);

  const barOf = useCallback(
    (tick: number) => Math.round(tick / ticksPerBar) + 1,
    [ticksPerBar],
  );

  // ---------------------------------------------------------------- nudge

  const applyNudge = useCallback(() => {
    if (nudgeMs === 0) return;
    onChange(offsetSyncPoints(points, nudgeMs));
    setNudgeMs(0);
  }, [nudgeMs, points, onChange]);

  // Live preview: shift the chart offset so the user hears the effect before committing.
  useEffect(() => {
    engine.clock.chartOffsetMs = -nudgeMs;
    return () => {
      engine.clock.chartOffsetMs = 0;
    };
  }, [engine, nudgeMs]);

  // ---------------------------------------------------------------- two-point

  const captureAnchor = useCallback(
    (tick: number) => {
      const point: SyncPoint = {
        mediaMs: positionRef.current,
        tick,
        confirmed: true,
      };

      if (!anchorA) {
        setAnchorA(point);
        return;
      }

      // Two anchors define offset + stretch. Rebuild from just these two — that's the
      // point of the mode, and keeping stale anchors would fight the new alignment.
      const [first, second] =
        anchorA.tick < point.tick ? [anchorA, point] : [point, anchorA];
      onChange([first, second]);
      setAnchorA(null);
    },
    [anchorA, onChange],
  );

  // ---------------------------------------------------------------- tap

  const tap = useCallback(() => {
    if (!tapping) return;
    setTaps((t) => [...t, positionRef.current]);
  }, [tapping]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.isContentEditable) return;
      if (e.code === "KeyT") {
        e.preventDefault();
        tap();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tap]);

  const commitTaps = useCallback(() => {
    if (taps.length < 2) return;
    onChange(syncPointsFromTaps(taps, tapStartBar, ticksPerBar));
    setTaps([]);
    setTapping(false);
  }, [taps, tapStartBar, ticksPerBar, onChange]);

  // ---------------------------------------------------------------- anchors

  const removePoint = useCallback(
    (index: number) => {
      onChange(points.filter((_, i) => i !== index));
    },
    [points, onChange],
  );

  const retimePoint = useCallback(
    (index: number) => {
      onChange(
        points.map((p, i) =>
          i === index
            ? { ...p, mediaMs: positionRef.current, confirmed: true }
            : p,
        ),
      );
    },
    [points, onChange],
  );

  // Derived quality signal: a sane alignment has monotonically increasing anchors and
  // a plausible implied tempo. Flag it when it doesn't, because a bad anchor produces
  // a cursor that lurches and it isn't obvious which anchor caused it.
  const problems = validateSyncPoints(points, ticksPerBar);

  return (
    <div className="synceditor">
      <header>
        <h2>Align chart to recording</h2>
        {onClose && (
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </header>

      <p className="muted synceditor-intro">
        The chart stores musical time; these anchors tie it to <em>this</em> recording.
        Align it once and the same chart will fit the remaster, the live version or a
        slowed-down copy — each just gets its own anchors.
      </p>

      <div className="synceditor-position">
        Playhead <span ref={readoutRef}>0:00</span>
      </div>

      <nav className="synceditor-modes">
        {(
          [
            ["nudge", "Nudge", "One offset for the whole song"],
            ["twoPoint", "Two-point", "Offset + stretch"],
            ["tap", "Tap", "An anchor per bar"],
          ] as const
        ).map(([key, label, hint]) => (
          <button
            key={key}
            className={mode === key ? "active" : ""}
            onClick={() => setMode(key)}
            title={hint}
          >
            {label}
          </button>
        ))}
      </nav>

      {mode === "nudge" && (
        <section className="synceditor-panel">
          <p>
            Play the song and slide until the cursor lands with the beat. You&rsquo;ll
            hear the change immediately.
          </p>
          <div className="synceditor-nudge">
            <input
              type="range"
              min={-2000}
              max={2000}
              step={10}
              value={nudgeMs}
              onChange={(e) => setNudgeMs(Number(e.target.value))}
            />
            <span className="synceditor-value">
              {nudgeMs > 0 ? "+" : ""}
              {nudgeMs} ms
            </span>
          </div>
          <div className="synceditor-fine">
            {[-100, -10, 10, 100].map((d) => (
              <button key={d} onClick={() => setNudgeMs((n) => n + d)}>
                {d > 0 ? "+" : ""}
                {d}
              </button>
            ))}
            <button onClick={() => setNudgeMs(0)}>Reset</button>
          </div>
          <button
            className="primary"
            onClick={applyNudge}
            disabled={nudgeMs === 0 || points.length === 0}
          >
            Apply offset to {points.length} anchor{points.length === 1 ? "" : "s"}
          </button>
          {points.length === 0 && (
            <p className="muted">
              No anchors yet — use Tap or Two-point first to create some.
            </p>
          )}
        </section>
      )}

      {mode === "twoPoint" && (
        <section className="synceditor-panel">
          <p>
            Park the playhead on a bar you can identify, then capture it. Do that twice,
            near the start and near the end, and the whole chart is stretched to fit.
          </p>
          {anchorA ? (
            <p className="synceditor-pending">
              First anchor set at {fmt(anchorA.mediaMs)} (bar {barOf(anchorA.tick)}).
              Now find a later bar.
            </p>
          ) : (
            <p className="muted">No anchor captured yet.</p>
          )}
          <div className="synceditor-capture">
            <label>
              This is bar
              <input
                type="number"
                min={1}
                defaultValue={1}
                id="twopoint-bar"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const bar = Number((e.target as HTMLInputElement).value);
                    captureAnchor((bar - 1) * ticksPerBar);
                  }
                }}
              />
            </label>
            <button
              onClick={() => {
                const el = document.getElementById(
                  "twopoint-bar",
                ) as HTMLInputElement | null;
                const bar = Number(el?.value ?? 1);
                captureAnchor((bar - 1) * ticksPerBar);
              }}
            >
              Capture here
            </button>
            {anchorA && <button onClick={() => setAnchorA(null)}>Cancel</button>}
          </div>
        </section>
      )}

      {mode === "tap" && (
        <section className="synceditor-panel">
          <p>
            Play the song and tap <kbd>T</kbd> on every downbeat &mdash; the
            &ldquo;one&rdquo; of each bar. This tracks a performance that drifts, which
            an offset can&rsquo;t.
          </p>
          <label>
            First tap is bar
            <input
              type="number"
              min={1}
              value={tapStartBar}
              onChange={(e) => setTapStartBar(Math.max(1, Number(e.target.value)))}
            />
          </label>

          {!tapping ? (
            <button
              className="primary"
              onClick={() => {
                setTaps([]);
                setTapping(true);
              }}
            >
              Start tapping
            </button>
          ) : (
            <>
              <button className="tap-big" onClick={tap}>
                Tap &mdash; bar {tapStartBar + taps.length}
              </button>
              <p className="muted">
                {taps.length} tap{taps.length === 1 ? "" : "s"}
                {taps.length >= 2 && ` · implied ${impliedBpmFromTaps(taps) ?? "—"} BPM`}
              </p>
              <button onClick={commitTaps} disabled={taps.length < 2}>
                Use these {taps.length} anchors
              </button>
              <button onClick={() => setTapping(false)}>Cancel</button>
            </>
          )}
        </section>
      )}

      {problems.length > 0 && (
        <div className="synceditor-problems warn">
          {problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}

      <section className="synceditor-anchors">
        <h3>
          Anchors <span className="muted">({points.length})</span>
        </h3>
        {points.length === 0 ? (
          <p className="muted">
            None. Without anchors the chart falls back to its own tempo map, which will
            drift against any real recording.
          </p>
        ) : (
          <ul>
            {points.map((p, i) => (
              <li key={`${p.tick}-${i}`}>
                <span className="anchor-bar">bar {barOf(p.tick)}</span>
                <span className="anchor-time">{fmt(p.mediaMs)}</span>
                {p.confirmed ? (
                  <span className="anchor-badge confirmed" title="Set by you">
                    ✓
                  </span>
                ) : (
                  <span className="anchor-badge" title="Generated by the analyzer">
                    auto
                  </span>
                )}
                <button onClick={() => void engine.seek(p.mediaMs)} title="Jump here">
                  ▸
                </button>
                <button onClick={() => retimePoint(i)} title="Move to playhead">
                  Set
                </button>
                <button onClick={() => removePoint(i)} title="Remove">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

function fmt(ms: number): string {
  const total = Math.max(0, ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}
