"use client";

/**
 * Transport bar: scrubbable playhead, time readout, song facts, lock indicator.
 *
 * PERFORMANCE NOTE, and it matters:
 * The playhead updates at 60fps. It does NOT go through React state — it writes
 * directly to DOM refs inside the engine's frame callback. Putting a 60fps value in
 * useState re-renders this subtree sixty times a second and, once the tab view and
 * lyrics are mounted, will visibly drop frames.
 *
 * React owns the things that change rarely (track name, key, BPM). Refs own the things
 * that change every frame (playhead, time readout).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncEngine } from "../lib/sync-engine";
import {
  formatKey,
  formatTimeSignature,
  type KeyMarker,
  type TimeSignature,
} from "../lib/types";

export interface TransportProps {
  engine: SyncEngine;
  title?: string;
  artist?: string;
  bpm?: number;
  timeSignature?: TimeSignature;
  musicalKey?: KeyMarker;
  /** 0..1 analyzer confidence; below 0.6 we visibly hedge rather than assert. */
  confidence?: { beats?: number; key?: number; chords?: number };
  canChangeRate?: boolean;
  onRateChange?: (rate: number) => void;
  onCalibrate?: () => void;
}

export function Transport({
  engine,
  title,
  artist,
  bpm,
  timeSignature,
  musicalKey,
  confidence,
  canChangeRate = false,
  onRateChange,
  onCalibrate,
}: TransportProps) {
  const fillRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const lockRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubbingRef = useRef(false);

  useEffect(() => {
    scrubbingRef.current = scrubbing;
  }, [scrubbing]);

  // The 60fps loop. Refs only — never setState in here.
  useEffect(() => {
    return engine.onFrame((positionMs) => {
      if (scrubbingRef.current) return;

      const duration = engine.duration || 1;
      const pct = Math.min(100, (positionMs / duration) * 100);

      if (fillRef.current) fillRef.current.style.width = `${pct}%`;
      if (knobRef.current) knobRef.current.style.left = `${pct}%`;
      if (timeRef.current) {
        timeRef.current.textContent = `${fmt(positionMs)} / ${fmt(duration)}`;
      }
      if (lockRef.current) {
        const q = engine.clock.lockQuality;
        lockRef.current.style.opacity = String(Math.max(0.15, 1 - q));
      }
    });
  }, [engine]);

  // Play state changes rarely — this one *is* React state.
  useEffect(() => {
    const id = setInterval(() => {
      setPlaying(engine.clock.isPlaying);
    }, 200);
    return () => clearInterval(id);
  }, [engine]);

  const positionFromEvent = useCallback(
    (clientX: number): number => {
      const bar = barRef.current;
      if (!bar) return 0;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return pct * engine.duration;
    },
    [engine],
  );

  const previewAt = useCallback((positionMs: number) => {
    const duration = engine.duration || 1;
    const pct = Math.min(100, (positionMs / duration) * 100);
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    if (knobRef.current) knobRef.current.style.left = `${pct}%`;
    if (timeRef.current) {
      timeRef.current.textContent = `${fmt(positionMs)} / ${fmt(duration)}`;
    }
  }, [engine]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setScrubbing(true);
      previewAt(positionFromEvent(e.clientX));
    },
    [positionFromEvent, previewAt],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!scrubbingRef.current) return;
      previewAt(positionFromEvent(e.clientX));
    },
    [positionFromEvent, previewAt],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!scrubbingRef.current) return;
      const pos = positionFromEvent(e.clientX);
      setScrubbing(false);
      scrubbingRef.current = false;
      void engine.seek(pos);
    },
    [engine, positionFromEvent],
  );

  const toggle = useCallback(() => {
    if (engine.clock.isPlaying) void engine.pause();
    else void engine.play();
  }, [engine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.isContentEditable) return;

      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.code === "ArrowLeft") {
        void engine.seek(Math.max(0, engine.clock.positionMs() - 5000));
      } else if (e.code === "ArrowRight") {
        void engine.seek(engine.clock.positionMs() + 5000);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, toggle]);

  const lowConfidence = (c?: number) => c !== undefined && c < 0.6;

  return (
    <div className="transport">
      <div className="transport-meta">
        <div className="transport-track">
          <strong>{title ?? "Nothing loaded"}</strong>
          {artist && <span className="muted"> — {artist}</span>}
        </div>

        <div className="transport-facts">
          {bpm !== undefined && (
            <Fact
              label="BPM"
              value={String(Math.round(bpm))}
              uncertain={lowConfidence(confidence?.beats)}
            />
          )}
          {timeSignature && (
            <Fact
              label="Time"
              value={formatTimeSignature(timeSignature)}
              uncertain={lowConfidence(confidence?.beats)}
            />
          )}
          {musicalKey && (
            <Fact
              label="Key"
              value={formatKey(musicalKey)}
              uncertain={lowConfidence(confidence?.key ?? musicalKey.confidence)}
            />
          )}
          <span
            ref={lockRef}
            className="transport-lock"
            title="Sync drift — brighter means the transport is reporting inconsistently"
          />
        </div>
      </div>

      <div className="transport-controls">
        <button onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>

        <div
          ref={barRef}
          className="scrub"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="slider"
          aria-label="Playhead"
          aria-valuemin={0}
          aria-valuemax={engine.duration}
          tabIndex={0}
        >
          <div className="scrub-track" />
          <div ref={fillRef} className="scrub-fill" />
          <div ref={knobRef} className="scrub-knob" />
        </div>

        <span ref={timeRef} className="transport-time">
          0:00 / 0:00
        </span>

        {canChangeRate ? (
          <label className="transport-rate">
            <span>{rate.toFixed(2)}×</span>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={rate}
              onChange={(e) => {
                const r = Number(e.target.value);
                setRate(r);
                onRateChange?.(r);
              }}
            />
          </label>
        ) : (
          <span
            className="transport-rate disabled"
            title="Spotify's Web Playback SDK has no playback-rate control. Use a local file or YouTube to practise slowly."
          >
            1.00×
          </span>
        )}

        {onCalibrate && (
          <button onClick={onCalibrate} title="Calibrate audio latency">
            ⏱
          </button>
        )}
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  uncertain,
}: {
  label: string;
  value: string;
  uncertain?: boolean;
}) {
  return (
    <span className={uncertain ? "fact uncertain" : "fact"}>
      <span className="fact-label">{label}</span>
      <span className="fact-value">
        {value}
        {uncertain && <span title="Low analyzer confidence">?</span>}
      </span>
    </span>
  );
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
