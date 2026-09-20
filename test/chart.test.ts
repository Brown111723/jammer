import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLrc, activeLineIndex } from "../lib/lyrics.ts";
import { TickMap, syncPointsFromBeatGrid, PPQ } from "../lib/types.ts";

test("LRC parser handles the shapes real files come in", () => {
  const lines = parseLrc(
    [
      "[ar:Fleetwood Mac]",
      "[00:27.93] Listen to the wind blow",
      "[00:30.88] Watch the sun rise",
      "[01:02.5] Tenths, not centiseconds",
      "[01:10.123] Millisecond precision",
      "[02:00.00][02:30.00] Repeated chorus line",
      "[100:05.00] Minutes past 99",
    ].join("\n"),
  );

  assert.equal(lines.length, 7, "metadata tags must be skipped, everything else kept");
  assert.equal(lines[0].mediaMs, 27_930, "mm:ss.cc");
  // Regression: a 1-digit fraction used to fail the regex and silently drop the line.
  assert.equal(lines[2].mediaMs, 62_500, "1-digit fraction is tenths");
  assert.equal(lines[3].mediaMs, 70_123, "3-digit fraction is milliseconds");
  assert.equal(
    lines.filter((l) => l.text === "Repeated chorus line").length,
    2,
    "multi-stamp lines expand",
  );
  assert.equal(lines[6].mediaMs, 6_005_000, "3-digit minutes");
  assert.ok(
    lines.every((l, i) => i === 0 || lines[i - 1].mediaMs <= l.mediaMs),
    "output is sorted",
  );
});

test("activeLineIndex finds the current lyric", () => {
  const lines = parseLrc("[00:10.00]a\n[00:20.00]b\n[00:30.00]c");
  assert.equal(activeLineIndex(lines, 0), -1, "before the first line");
  assert.equal(activeLineIndex(lines, 10_000), 0, "exactly on a line");
  assert.equal(activeLineIndex(lines, 15_000), 0, "between lines holds the previous");
  assert.equal(activeLineIndex(lines, 999_999), 2, "past the end holds the last");
  assert.equal(
    activeLineIndex([{ mediaMs: -1, text: "unsynced" }], 500),
    -1,
    "unsynced lyrics never highlight",
  );
});

test("TickMap interpolates between sync points", () => {
  // 120bpm 4/4: one bar = 2000ms = 4*PPQ ticks, starting 1s into the recording.
  const map = new TickMap([
    { mediaMs: 1000, tick: 0 },
    { mediaMs: 3000, tick: 4 * PPQ },
  ]);

  assert.equal(map.tickToMs(0), 1000);
  assert.equal(map.tickToMs(2 * PPQ), 2000, "half a bar");
  assert.equal(map.tickToMs(4 * PPQ), 3000);
  assert.equal(map.msToTick(2000), 2 * PPQ, "inverse mapping");
  assert.ok(
    Math.abs(map.msToTick(map.tickToMs(1234)) - 1234) < 1e-6,
    "round-trips",
  );
});

test("TickMap extrapolates outside the sync points", () => {
  const map = new TickMap([
    { mediaMs: 1000, tick: 0 },
    { mediaMs: 3000, tick: 4 * PPQ },
  ]);
  assert.equal(map.tickToMs(-4 * PPQ), -1000, "before the first point");
  assert.equal(map.tickToMs(8 * PPQ), 5000, "after the last point");
});

test("TickMap tracks a tempo that drifts between points", () => {
  const drift = new TickMap([
    { mediaMs: 0, tick: 0 },
    { mediaMs: 2000, tick: 4 * PPQ },
    { mediaMs: 3800, tick: 8 * PPQ }, // second bar is faster
  ]);
  assert.equal(drift.tickToMs(2 * PPQ), 1000, "first segment");
  assert.ok(
    Math.abs(drift.tickToMs(6 * PPQ) - 2900) < 1e-6,
    "second segment uses its own slope",
  );
});

test("TickMap falls back to a tempo when it has no sync points", () => {
  assert.equal(new TickMap([]).tickToMs(PPQ), 500, "120bpm quarter note");
});

test("sync points are derived from downbeats at a usable density", () => {
  const beats = [];
  for (let bar = 1; bar <= 16; bar++) {
    for (let b = 1; b <= 4; b++) {
      beats.push({
        mediaMs: ((bar - 1) * 4 + (b - 1)) * 500,
        beatInBar: b,
        bar,
        confidence: 0.9,
      });
    }
  }

  const points = syncPointsFromBeatGrid({ beats, nominalBpm: 120 }, PPQ, 4);

  assert.equal(points.length, 4, "one anchor per 4 bars, not one per beat");
  assert.deepEqual(points[0], { mediaMs: 0, tick: 0, confirmed: false });
  assert.equal(points[1].mediaMs, 8000);
  assert.equal(points[1].tick, 16 * PPQ);
  assert.ok(
    points.every((p) => p.confirmed === false),
    "machine-generated anchors are never marked confirmed",
  );
});
