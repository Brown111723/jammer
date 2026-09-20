/**
 * The clock is the component whose failures are subtle: a cursor that is 2ms jerky or
 * 80ms behind still "works", it just feels wrong, and feeling wrong is the one thing
 * this app cannot afford. So it gets simulated rather than eyeballed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackClock } from "../lib/clock.ts";

/** Deterministic clock so the sim is reproducible. */
function withFakeTime<T>(fn: (advance: (ms: number) => void) => T): T {
  const original = globalThis.performance;
  let simNow = 0;
  (globalThis as unknown as { performance: unknown }).performance = {
    now: () => simNow,
    timeOrigin: 0,
  };
  try {
    return fn((ms) => {
      simNow += ms;
    });
  } finally {
    (globalThis as unknown as { performance: unknown }).performance = original;
  }
}

/**
 * Simulates a Spotify-like transport: reports every ~200ms, quantised to 100ms,
 * with 20-80ms of variable staleness.
 */
function simulate(opts: { seekAtFrame?: number } = {}) {
  return withFakeTime((advance) => {
    const clock = new PlaybackClock();
    clock.setPlaying(true, 0, 0);

    let simNow = 0;
    let truePosition = 0;
    let lastDisplay = 0;
    let maxJump = 0;
    let sumAbsError = 0;
    let samples = 0;

    const POLL_MS = 200;
    let nextPoll = POLL_MS;
    // Deterministic pseudo-random staleness.
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let frame = 1; frame <= 1800; frame++) {
      const dt = 1000 / 60;
      advance(dt);
      simNow += dt;
      truePosition += dt;

      if (frame === opts.seekAtFrame) {
        truePosition = 90_000;
        clock.seek(90_000, simNow);
      }

      if (simNow >= nextPoll) {
        nextPoll += POLL_MS;
        const staleness = 20 + rand() * 60;
        clock.observe({
          positionMs: Math.floor((truePosition - staleness) / 100) * 100,
          atWallMs: simNow - staleness,
          playing: true,
          rate: 1,
        });
      }

      const display = clock.positionForDisplay(simNow);
      const jump = Math.abs(display - lastDisplay - dt);
      lastDisplay = display;

      const nearSeek =
        opts.seekAtFrame !== undefined && Math.abs(frame - opts.seekAtFrame) <= 5;
      if (frame > 120 && !nearSeek) {
        maxJump = Math.max(maxJump, jump);
        sumAbsError += Math.abs(display - truePosition);
        samples++;
      }
    }

    return {
      maxJumpMs: maxJump,
      meanErrorMs: sumAbsError / samples,
      lockQuality: clock.lockQuality,
    };
  });
}

test("cursor advances smoothly despite a coarse, stale, jittery transport", () => {
  const r = simulate();
  // A per-frame deviation above ~1ms starts to read as a tick at 60fps.
  assert.ok(
    r.maxJumpMs < 1,
    `max per-frame jump was ${r.maxJumpMs.toFixed(2)}ms — cursor will look jerky`,
  );
});

test("tracks true position within the transport's staleness floor", () => {
  const r = simulate();
  // Reports average 50ms stale, so ~50ms of error is the floor, not a defect.
  assert.ok(
    r.meanErrorMs < 120,
    `mean error was ${r.meanErrorMs.toFixed(2)}ms`,
  );
});

test("reports a high lock quality once settled", () => {
  const r = simulate();
  assert.ok(r.lockQuality > 0.8, `lock quality was ${r.lockQuality.toFixed(3)}`);
});

test("recovers smoothly from a seek", () => {
  const r = simulate({ seekAtFrame: 600 });
  assert.ok(
    r.maxJumpMs < 1,
    `max jump after seek recovery was ${r.maxJumpMs.toFixed(2)}ms`,
  );
});

test("a large discrepancy re-anchors hard instead of drifting for seconds", () => {
  withFakeTime((advance) => {
    const clock = new PlaybackClock();
    clock.setPlaying(true, 0, 0);
    advance(1000);

    // Track change: transport jumps somewhere completely different.
    clock.observe({ positionMs: 60_000, atWallMs: 1000, playing: true, rate: 1 });

    assert.ok(
      Math.abs(clock.positionMs(1000) - 60_000) < 1,
      "a >250ms discrepancy must snap, not ease",
    );
  });
});

test("small drift is absorbed by rate trim, not by jumping", () => {
  withFakeTime((advance) => {
    const clock = new PlaybackClock();
    clock.setPlaying(true, 0, 0);
    advance(1000);

    const before = clock.positionMs(1000);
    // 80ms behind — within the soft window.
    clock.observe({ positionMs: 1080, atWallMs: 1000, playing: true, rate: 1 });
    const after = clock.positionMs(1000);

    assert.ok(
      Math.abs(after - before) < 1,
      "position must stay continuous across a soft correction",
    );
    assert.ok(clock.effectiveRate > 1, "rate should speed up to close the gap");
    assert.ok(clock.effectiveRate <= 1.02, "rate trim must stay bounded");
  });
});

test("pause freezes the cursor", () => {
  withFakeTime((advance) => {
    const clock = new PlaybackClock();
    clock.setPlaying(true, 0, 0);
    advance(5000);
    clock.observe({ positionMs: 5000, atWallMs: 5000, playing: false, rate: 1 });

    const atPause = clock.positionMs(5000);
    advance(3000);
    assert.equal(clock.positionMs(8000), atPause, "paused clock must not advance");
  });
});

test("latency and chart offsets shift the display without moving the media clock", () => {
  withFakeTime((advance) => {
    const clock = new PlaybackClock();
    clock.setPlaying(true, 0, 0);
    clock.outputLatencyMs = 200;
    clock.chartOffsetMs = 50;
    advance(10_000);

    assert.equal(clock.positionMs(10_000), 10_000);
    assert.equal(clock.positionForDisplay(10_000), 9750);
  });
});

test("display position never goes negative", () => {
  withFakeTime(() => {
    const clock = new PlaybackClock();
    clock.outputLatencyMs = 300;
    clock.setPlaying(true, 0, 0);
    assert.equal(clock.positionForDisplay(0), 0);
  });
});
