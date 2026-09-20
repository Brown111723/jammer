"use client";

/**
 * "What to play now / next" — chord diagrams beside the highway.
 *
 * The highway tells you *when*. This tells you *what shape*, which is the thing a
 * player actually needs when a chord they don't know is four seconds out. Showing the
 * next chord early is the whole point: by the time it arrives you should already have
 * your fingers moving.
 *
 * Like the highway, the active chord is tracked in a ref and only promoted to React
 * state when it actually changes — typically every few seconds rather than every frame.
 */

import { useEffect, useRef, useState } from "react";
import { chordsAround, voicingFor, type Voicing } from "../lib/fretboard";
import type { SyncEngine } from "../lib/sync-engine";

export interface ChordPanelProps {
  engine: SyncEngine;
  /** Chords resolved into recording milliseconds. */
  chords: { mediaMs: number; symbol: string; confidence?: number }[];
}

export function ChordPanel({ engine, chords }: ChordPanelProps) {
  const [current, setCurrent] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<{ current: string | null; next: string | null }>({
    current: null,
    next: null,
  });

  useEffect(() => {
    return engine.onFrame((positionMs) => {
      const around = chordsAround(chords, positionMs);

      // Countdown bar is pure DOM — it changes every frame.
      if (countdownRef.current && around.next) {
        // Fill over the last 4 seconds before the change.
        const pct = Math.max(0, Math.min(1, 1 - around.nextInMs / 4000));
        countdownRef.current.style.transform = `scaleX(${pct})`;
      }

      const last = lastRef.current;
      if (around.current !== last.current || around.next !== last.next) {
        lastRef.current = { current: around.current, next: around.next };
        setCurrent(around.current);
        setNext(around.next);
      }
    });
  }, [engine, chords]);

  if (chords.length === 0) {
    return (
      <div className="chordpanel empty">
        <p className="muted">
          No chord track. Run the analyzer, or load a score that has one.
        </p>
      </div>
    );
  }

  return (
    <div className="chordpanel">
      <div className="chordpanel-now">
        <span className="chordpanel-label">Now</span>
        <ChordDiagram symbol={current} size="large" />
      </div>

      <div className="chordpanel-countdown">
        <div ref={countdownRef} className="chordpanel-countdown-fill" />
      </div>

      <div className="chordpanel-next">
        <span className="chordpanel-label">Next</span>
        <ChordDiagram symbol={next} size="small" />
      </div>
    </div>
  );
}

/**
 * A chord diagram: six strings, five frets, dots where fingers go.
 *
 * Drawn as SVG rather than canvas — it changes rarely, needs to scale crisply, and
 * being in the DOM means it's selectable and accessible.
 */
export function ChordDiagram({
  symbol,
  size = "large",
}: {
  symbol: string | null;
  size?: "large" | "small";
}) {
  const voicing = symbol ? voicingFor(symbol) : null;

  if (!symbol) {
    return <div className={`chord-diagram ${size} placeholder`}>—</div>;
  }

  if (!voicing) {
    // We know the chord but not a shape for it. Say so rather than drawing a guess.
    return (
      <div className={`chord-diagram ${size}`}>
        <div className="chord-name">{symbol}</div>
        <div className="chord-unknown muted">no shape</div>
      </div>
    );
  }

  return (
    <div className={`chord-diagram ${size}`}>
      <div className="chord-name">{symbol}</div>
      <ChordGrid voicing={voicing} compact={size === "small"} />
    </div>
  );
}

function ChordGrid({ voicing, compact }: { voicing: Voicing; compact: boolean }) {
  const strings = voicing.frets.length;
  const fretCount = 5;

  const w = compact ? 64 : 96;
  const h = compact ? 78 : 116;
  const padX = w * 0.14;
  const padTop = h * 0.2;
  const padBottom = h * 0.08;

  const stringGap = (w - padX * 2) / (strings - 1);
  const fretGap = (h - padTop - padBottom) / fretCount;

  // When the shape sits up the neck, renumber the grid and show the base fret.
  const played = voicing.frets.filter((f) => f > 0);
  const minFret = played.length ? Math.min(...played) : 1;
  const showFrom = minFret > 4 ? minFret : 1;

  const x = (s: number) => padX + s * stringGap;
  const y = (fretRow: number) => padTop + fretRow * fretGap;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="chord-grid"
      role="img"
      aria-label={`${voicing.name} chord diagram`}
    >
      {/* Nut, if we're at the top of the neck */}
      {showFrom === 1 && (
        <rect x={padX} y={padTop - 3} width={w - padX * 2} height={3} fill="currentColor" />
      )}

      {/* Frets */}
      {Array.from({ length: fretCount + 1 }, (_, i) => (
        <line
          key={`f${i}`}
          x1={padX}
          y1={y(i)}
          x2={w - padX}
          y2={y(i)}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeWidth={1}
        />
      ))}

      {/* Strings */}
      {Array.from({ length: strings }, (_, s) => (
        <line
          key={`s${s}`}
          x1={x(s)}
          y1={padTop}
          x2={x(s)}
          y2={y(fretCount)}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeWidth={1}
        />
      ))}

      {/* Base fret marker */}
      {showFrom > 1 && (
        <text
          x={padX - 6}
          y={y(0.5)}
          fontSize={compact ? 8 : 10}
          textAnchor="end"
          fill="currentColor"
          fillOpacity={0.7}
        >
          {showFrom}
        </text>
      )}

      {/* Barre */}
      {voicing.barre && voicing.barre.fret >= showFrom && (
        <rect
          x={x(voicing.barre.fromString) - 4}
          y={y(voicing.barre.fret - showFrom + 0.5) - 4}
          width={x(voicing.barre.toString) - x(voicing.barre.fromString) + 8}
          height={8}
          rx={4}
          fill="currentColor"
          fillOpacity={0.9}
        />
      )}

      {/* Dots, opens and mutes */}
      {voicing.frets.map((fret, s) => {
        if (fret === -1) {
          return (
            <text
              key={`m${s}`}
              x={x(s)}
              y={padTop - 6}
              fontSize={compact ? 8 : 10}
              textAnchor="middle"
              fill="currentColor"
              fillOpacity={0.55}
            >
              ×
            </text>
          );
        }
        if (fret === 0) {
          return (
            <circle
              key={`o${s}`}
              cx={x(s)}
              cy={padTop - 8}
              r={compact ? 2.5 : 3.5}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.7}
              strokeWidth={1.2}
            />
          );
        }
        const row = fret - showFrom + 0.5;
        if (row < 0 || row > fretCount) return null;
        return (
          <circle
            key={`d${s}`}
            cx={x(s)}
            cy={y(row)}
            r={compact ? 4 : 5.5}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}
