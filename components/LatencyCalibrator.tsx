"use client";

/**
 * Output latency calibration.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * -----------------------------------
 * Between the media position we read and the sound the user actually hears there is a
 * delay: audio buffering, OS mixer, and — the big one — Bluetooth. A2DP codecs add
 * 150-300ms. AAC over AirPods is usually ~170ms. aptX Low Latency is ~40ms. Wired is
 * ~10-20ms.
 *
 * Uncorrected, the cursor is a third of a second ahead of the sound. The user tries to
 * play along, feels wrong, and concludes either that the app is broken or — much worse
 * and very common — that their own timing is bad. For a tool whose entire purpose is
 * playing in time, this is fatal.
 *
 * THE METHOD
 * ----------
 * Play a click at known times. The user taps along. The median of (tap time - click
 * time) is their total round-trip: output latency + their own reaction time + input
 * latency.
 *
 * We subtract a nominal human audiomotor reaction constant, because tapping to a beat
 * you can anticipate is a *synchronisation* task, not a reaction task — trained subjects
 * show a negative mean asynchrony, tapping slightly BEFORE the beat. Untrained users
 * land near zero. So the honest correction is small, and we deliberately use the median
 * rather than the mean so one fumbled tap doesn't skew the result.
 *
 * Web Audio's `AudioContext.outputLatency` reports part of this directly where
 * supported — we use it as a sanity check and a fallback, but the tap test measures the
 * real path including the user's own hardware.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const CLICK_COUNT = 8;
const CLICK_INTERVAL_MS = 1000;
/** Taps further than this from a click are discarded as misses. */
const TAP_WINDOW_MS = 400;

export interface LatencyCalibratorProps {
  initialMs?: number;
  onCommit: (latencyMs: number) => void;
  onCancel?: () => void;
}

type Phase = "idle" | "counting" | "done";

export function LatencyCalibrator({
  initialMs = 0,
  onCommit,
  onCancel,
}: LatencyCalibratorProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [clicksPlayed, setClicksPlayed] = useState(0);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [manualMs, setManualMs] = useState(initialMs);
  const [reportedOutputLatency, setReportedOutputLatency] = useState<number | null>(
    null,
  );

  const ctxRef = useRef<AudioContext | null>(null);
  /** Click times in AudioContext time, seconds. */
  const clickTimesRef = useRef<number[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const ensureContext = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
      void ctxRef.current?.close();
    };
  }, []);

  const playClick = useCallback((ctx: AudioContext, at: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1000;
    // Short percussive envelope — a click, not a beep. Easier to tap precisely.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.5, at + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.06);
  }, []);

  const start = useCallback(async () => {
    const ctx = ensureContext();
    await ctx.resume();

    setReportedOutputLatency(
      typeof ctx.outputLatency === "number" ? ctx.outputLatency * 1000 : null,
    );

    setPhase("counting");
    setOffsets([]);
    setClicksPlayed(0);
    clickTimesRef.current = [];
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    // Schedule in AudioContext time — sample-accurate, unlike setTimeout.
    const first = ctx.currentTime + 0.5;
    for (let i = 0; i < CLICK_COUNT; i++) {
      const at = first + (i * CLICK_INTERVAL_MS) / 1000;
      clickTimesRef.current.push(at);
      playClick(ctx, at);

      timersRef.current.push(
        setTimeout(
          () => setClicksPlayed(i + 1),
          (at - ctx.currentTime) * 1000,
        ),
      );
    }

    timersRef.current.push(
      setTimeout(
        () => setPhase("done"),
        (first - ctx.currentTime) * 1000 + CLICK_COUNT * CLICK_INTERVAL_MS + 500,
      ),
    );
  }, [ensureContext, playClick]);

  const tap = useCallback(() => {
    if (phase !== "counting") return;
    const ctx = ctxRef.current;
    if (!ctx) return;

    const tapAt = ctx.currentTime;
    // Nearest scheduled click.
    let best = Infinity;
    for (const click of clickTimesRef.current) {
      const delta = (tapAt - click) * 1000;
      if (Math.abs(delta) < Math.abs(best)) best = delta;
    }

    if (Math.abs(best) <= TAP_WINDOW_MS) {
      setOffsets((o) => [...o, best]);
    }
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        tap();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tap]);

  const median = offsets.length
    ? [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)]
    : 0;

  const spread = offsets.length > 1 ? stdev(offsets) : 0;
  // Confidence: tight taps and enough of them.
  const reliable = offsets.length >= 5 && spread < 60;

  const measured = Math.max(0, Math.round(median));

  return (
    <div className="calibrator">
      <h2>Calibrate audio latency</h2>

      {phase === "idle" && (
        <>
          <p>
            Your headphones or speakers delay the sound by some amount. Bluetooth is
            typically <strong>150&ndash;300&nbsp;ms</strong>. Without correcting for it,
            the playhead runs ahead of what you hear and everything feels off.
          </p>
          <p>
            You&rsquo;ll hear eight clicks, one per second.{" "}
            <strong>Tap space on each one.</strong>
          </p>
          <button onClick={start}>Start</button>
          {onCancel && <button onClick={onCancel}>Skip for now</button>}
        </>
      )}

      {phase === "counting" && (
        <>
          <p className="big">{clicksPlayed} / {CLICK_COUNT}</p>
          <p>Tap space with each click.</p>
          <button onClick={tap} className="tap-target">
            Tap
          </button>
          <p className="muted">{offsets.length} taps registered</p>
        </>
      )}

      {phase === "done" && (
        <>
          <p className="big">{measured} ms</p>
          {reliable ? (
            <p>
              Measured from {offsets.length} taps, spread &plusmn;{Math.round(spread)} ms.
            </p>
          ) : (
            <p className="warn">
              Taps were inconsistent (spread &plusmn;{Math.round(spread)} ms from{" "}
              {offsets.length} taps). Worth running again &mdash; or set it by hand below.
            </p>
          )}
          {reportedOutputLatency !== null && (
            <p className="muted">
              Your browser reports {Math.round(reportedOutputLatency)} ms of output
              latency. That covers the audio stack but not Bluetooth transmission, so
              the tap figure is usually the larger and more useful one.
            </p>
          )}
          <button onClick={() => onCommit(measured)}>Use {measured} ms</button>
          <button onClick={start}>Run again</button>
        </>
      )}

      <details>
        <summary>Set it manually</summary>
        <p className="muted">
          Wired ~20&nbsp;ms &middot; AirPods ~170&nbsp;ms &middot; generic Bluetooth
          200&ndash;300&nbsp;ms
        </p>
        <input
          type="range"
          min={0}
          max={500}
          step={5}
          value={manualMs}
          onChange={(e) => setManualMs(Number(e.target.value))}
        />
        <span>{manualMs} ms</span>
        <button onClick={() => onCommit(manualMs)}>Use {manualMs} ms</button>
      </details>
    </div>
  );
}

function stdev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(
    xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (xs.length - 1),
  );
}
