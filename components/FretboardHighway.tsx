"use client";

/**
 * The fretboard highway — Guitar Hero's scrolling view, but mapped to a real guitar.
 *
 * WHY LANES ARE STRINGS
 * ---------------------
 * Guitar Hero has five lanes that mean nothing musically. Here a lane *is* a string,
 * and the number inside each note is the fret. So the display is a literal instruction:
 * "this finger, that string, that fret, now." You can learn to read it in a song or two,
 * and unlike Guitar Hero what you learn transfers to the actual instrument.
 *
 * WHY CANVAS, NOT DOM
 * -------------------
 * At 60fps with a few hundred visible notes, DOM nodes with CSS transforms will drop
 * frames on a laptop, and this is the one view where a dropped frame is felt rather
 * than seen. Canvas draws the whole scene in one pass with no layout, no style
 * recalculation and no garbage per frame.
 *
 * Nothing here goes through React state. The component mounts a canvas, subscribes to
 * the engine's frame callback and draws. React re-renders only when the track changes.
 *
 * THE PERSPECTIVE
 * ---------------
 * Notes approach from a horizon and are struck at a line near the bottom. The
 * projection is a real 1/d perspective rather than a linear ramp, because linear
 * scrolling reads as "sliding up a wall" while 1/d reads as "coming toward you" — and
 * the compression near the horizon is what lets you see four seconds ahead without the
 * near notes becoming too fast to read.
 */

import { useEffect, useRef } from "react";
import {
  STRING_COLORS,
  STRING_LABELS_BASS,
  STRING_LABELS_GUITAR,
  firstNoteAtOrAfter,
  type HighwayNote,
} from "../lib/fretboard";
import type { SyncEngine } from "../lib/sync-engine";
import type { Beat } from "../lib/types";

export interface FretboardHighwayProps {
  engine: SyncEngine;
  notes: HighwayNote[];
  /** Beat grid, in recording ms — drawn as cross-lines so you can feel the tempo. */
  beats?: Beat[];
  stringCount?: number;
  /** How far ahead to show, in ms. 2500-4000 is the readable range. */
  lookAheadMs?: number;
  /** Left-handed players read the strings mirrored. */
  mirrored?: boolean;
}

/** Depth of the virtual fretboard. Higher = more compression toward the horizon. */
const DEPTH = 5.5;
/** Fraction of canvas height where the hit line sits. */
const HIT_LINE = 0.82;
/** Fraction of canvas height where the horizon sits. */
const HORIZON = 0.08;

export function FretboardHighway({
  engine,
  notes,
  beats = [],
  stringCount = 6,
  lookAheadMs = 3000,
  mirrored = false,
}: FretboardHighwayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Held in refs so the draw loop never restarts when they change.
  const notesRef = useRef(notes);
  const beatsRef = useRef(beats);
  const optsRef = useRef({ stringCount, lookAheadMs, mirrored });

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  useEffect(() => {
    beatsRef.current = beats;
  }, [beats]);
  useEffect(() => {
    optsRef.current = { stringCount, lookAheadMs, mirrored };
  }, [stringCount, lookAheadMs, mirrored]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    /**
     * Map depth z (0 = hit line, 1 = horizon) to a screen scale factor.
     * A 1/d falloff: near things are big and move fast, far things compress.
     */
    const scaleAt = (z: number) => 1 / (1 + z * DEPTH);
    const NEAR_SCALE = scaleAt(0); // 1
    const FAR_SCALE = scaleAt(1);

    const yAt = (z: number, h: number) => {
      const hitY = h * HIT_LINE;
      const horizonY = h * HORIZON;
      // Normalise the scale range so z=0 lands on the hit line and z=1 on the horizon.
      const t = (NEAR_SCALE - scaleAt(z)) / (NEAR_SCALE - FAR_SCALE);
      return hitY - (hitY - horizonY) * t;
    };

    /** Recently-struck notes, for the hit flash. */
    const flashes: { x: number; color: string; at: number }[] = [];

    const draw = (positionMs: number) => {
      const { stringCount: n, lookAheadMs: look, mirrored: mir } = optsRef.current;
      const w = width;
      const h = height;
      if (w === 0 || h === 0) return;

      const hitY = h * HIT_LINE;
      const centerX = w / 2;
      // Lane spacing chosen so the board fills ~70% of the width at the hit line.
      const laneSpacing = (w * 0.7) / n;

      const laneX = (stringIndex: number, z: number) => {
        const idx = mir ? n - 1 - stringIndex : stringIndex;
        const offset = (idx - (n - 1) / 2) * laneSpacing;
        return centerX + offset * scaleAt(z) * (1 / NEAR_SCALE);
      };

      // ---------------------------------------------------------- background
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#07080b");
      bg.addColorStop(0.5, "#0e0f12");
      bg.addColorStop(1, "#15171d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // ---------------------------------------------------------- beat lines
      // Drawn first so notes sit on top. These give the board its sense of speed
      // and let you see the bar coming.
      const bl = beatsRef.current;
      if (bl.length) {
        for (const beat of bl) {
          const dt = beat.mediaMs - positionMs;
          if (dt < -200 || dt > look) continue;
          const z = Math.max(0, dt / look);
          const y = yAt(z, h);
          const s = scaleAt(z) / NEAR_SCALE;

          const left = laneX(0, z) - laneSpacing * 0.5 * s;
          const right = laneX(n - 1, z) + laneSpacing * 0.5 * s;

          const downbeat = beat.beatInBar === 1;
          // Fade with distance, but not linearly — a linear fade makes far bar lines
          // invisible well before they're far enough away to be irrelevant.
          const fade = Math.sqrt(s);
          ctx.strokeStyle = downbeat
            ? `rgba(255,255,255,${0.42 * fade})`
            : `rgba(255,255,255,${0.12 * fade})`;
          ctx.lineWidth = downbeat ? 2 * s : 1 * s;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();

          // Bar numbers are how you orient the highway against the notation view and
          // against the sync editor's anchors, so they need to be readable, not decorative.
          // Threshold is low on purpose: at 100bpm a 4/4 bar is 2.4s, so with a 3s
          // lead most visible bar lines sit deep in the perspective. A stricter cutoff
          // means the numbers almost never appear.
          if (downbeat && s > 0.12) {
            ctx.fillStyle = `rgba(255,255,255,${0.8 * fade})`;
            ctx.font = `600 ${Math.max(10, Math.round(14 * fade))}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(String(beat.bar), left - 8 * fade, y);
          }
        }
      }

      // ---------------------------------------------------------- lane lines
      for (let s = 0; s < n; s++) {
        ctx.beginPath();
        ctx.moveTo(laneX(s, 0), hitY);
        ctx.lineTo(laneX(s, 1), yAt(1, h));
        const grad = ctx.createLinearGradient(0, hitY, 0, yAt(1, h));
        grad.addColorStop(0, `${STRING_COLORS[s % 6]}44`);
        grad.addColorStop(1, `${STRING_COLORS[s % 6]}08`);
        ctx.strokeStyle = grad;
        // Thicker low strings, like the real instrument.
        ctx.lineWidth = 2.4 - (s / n) * 1.4;
        ctx.stroke();
      }

      // ---------------------------------------------------------- notes
      const all = notesRef.current;
      // Include notes slightly in the past so a note is still visible as it's struck.
      const start = firstNoteAtOrAfter(all, positionMs - 250);
      const noteRadius = Math.min(laneSpacing * 0.42, 26);

      // Draw far-to-near so nearer notes overlap correctly.
      const visible: HighwayNote[] = [];
      for (let i = start; i < all.length; i++) {
        const dt = all[i].mediaMs - positionMs;
        if (dt > look) break;
        visible.push(all[i]);
      }

      for (let i = visible.length - 1; i >= 0; i--) {
        const note = visible[i];
        const dt = note.mediaMs - positionMs;
        const z = Math.max(0, Math.min(1, dt / look));
        const y = yAt(z, h);
        const s = scaleAt(z) / NEAR_SCALE;
        const x = laneX(note.string, z);
        const r = noteRadius * s;
        const color = STRING_COLORS[note.string % 6];

        // Sustain tail for held notes.
        if (note.durationMs > 180) {
          const endDt = dt + note.durationMs;
          const endZ = Math.max(0, Math.min(1, endDt / look));
          const endY = yAt(endZ, h);
          const endS = scaleAt(endZ) / NEAR_SCALE;

          ctx.beginPath();
          ctx.moveTo(x - r * 0.32, y);
          ctx.lineTo(laneX(note.string, endZ) - noteRadius * endS * 0.32, endY);
          ctx.lineTo(laneX(note.string, endZ) + noteRadius * endS * 0.32, endY);
          ctx.lineTo(x + r * 0.32, y);
          ctx.closePath();
          ctx.fillStyle = `${color}33`;
          ctx.fill();
        }

        // The note itself. Struck notes are the ones at or just past the hit line.
        const struck = dt <= 0;
        if (struck && dt > -60) {
          flashes.push({ x, color, at: performance.now() });
        }

        ctx.globalAlpha = struck ? Math.max(0, 1 + dt / 250) : 1;

        // Glow, brighter as it approaches.
        ctx.shadowColor = color;
        ctx.shadowBlur = 14 * s;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Darker core so the fret number stays readable against the fill.
        ctx.beginPath();
        ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(10,11,14,0.82)";
        ctx.fill();

        if (r > 8) {
          ctx.fillStyle = "#fff";
          ctx.font = `600 ${Math.round(r * 0.95)}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(note.fret), x, y + r * 0.04);
        }

        ctx.globalAlpha = 1;
      }

      // ---------------------------------------------------------- hit line
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(laneX(0, 0) - laneSpacing * 0.5, hitY);
      ctx.lineTo(laneX(n - 1, 0) + laneSpacing * 0.5, hitY);
      ctx.stroke();

      // Target rings on the hit line.
      for (let s = 0; s < n; s++) {
        ctx.beginPath();
        ctx.arc(laneX(s, 0), hitY, noteRadius * 0.92, 0, Math.PI * 2);
        ctx.strokeStyle = `${STRING_COLORS[s % 6]}66`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // ---------------------------------------------------------- hit flashes
      const nowMs = performance.now();
      for (let i = flashes.length - 1; i >= 0; i--) {
        const age = nowMs - flashes[i].at;
        if (age > 260) {
          flashes.splice(i, 1);
          continue;
        }
        const t = age / 260;
        ctx.globalAlpha = (1 - t) * 0.65;
        ctx.beginPath();
        ctx.arc(flashes[i].x, hitY, noteRadius * (1 + t * 1.6), 0, Math.PI * 2);
        ctx.strokeStyle = flashes[i].color;
        ctx.lineWidth = 3 * (1 - t);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ---------------------------------------------------------- string labels
      const labels = n === 4 ? STRING_LABELS_BASS : STRING_LABELS_GUITAR;
      ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let s = 0; s < n; s++) {
        ctx.fillStyle = `${STRING_COLORS[s % 6]}cc`;
        ctx.fillText(labels[s] ?? String(s + 1), laneX(s, 0), hitY + 26);
      }
    };

    const unsubscribe = engine.onFrame(draw);

    // Draw once immediately so the board isn't blank before playback starts.
    draw(engine.clock.positionForDisplay());

    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, [engine]);

  return <canvas ref={canvasRef} className="highway" />;
}
