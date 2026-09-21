/**
 * Guitar Pro import, tested against a real file: The Screaming Jets – "Better".
 *
 * It's a good torture test. Four repeated sections (one with first/second endings),
 * a tempo change from 100 to 104 BPM at the "Double time Feel", three string tracks
 * including a 4-string bass, a drum track, and named chord diagrams.
 */
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as alphaTab from "@coderline/alphatab";
import {
  scoreToChart,
  playbackBars,
  normaliseChordName,
  type AlphaTabModule,
} from "../lib/score-import.ts";
import { TickMap } from "../lib/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "better.gp5");

// The fixture is a commercially transcribed tab, so it is NOT committed (see
// .gitignore). Drop your own copy at test/fixtures/better.gp5 to run these.
const HAVE_FIXTURE = existsSync(FIXTURE);
function test(name: string, fn: () => void) {
  nodeTest(name, { skip: HAVE_FIXTURE ? false : "test/fixtures/better.gp5 not present" }, fn);
}

function load() {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const settings = new alphaTab.Settings();
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  const chart = scoreToChart(alphaTab as unknown as AlphaTabModule, score as never, {
    recording: { transport: "youtube", id: "9NPv_ZsMgIg" },
    fileName: "better.gp5",
    fileSize: bytes.length,
    settings,
  });
  return { score, chart, settings };
}

test("repeats and alternate endings are unrolled into played order", () => {
  const { score, settings } = load();
  const bars = playbackBars(alphaTab as unknown as AlphaTabModule, score as never, settings);

  assert.equal(score.masterBars.length, 65, "65 bars as written");
  assert.equal(bars.length, 93, "93 bars as played");

  const order = bars.map((b) => b.masterBar.index);
  // The intro riff 8-11 repeats before the verse at 12.
  assert.deepEqual(order.slice(8, 16), [8, 9, 10, 11, 8, 9, 10, 11]);
  // Pre-chorus with first/second endings: 16, 17 (1st), 16, 18 (2nd).
  const at = order.indexOf(16);
  assert.deepEqual(order.slice(at, at + 4), [16, 17, 16, 18]);

  // Played ticks are contiguous — no gaps or overlaps.
  for (let i = 1; i < bars.length; i++) {
    assert.equal(bars[i].start, bars[i - 1].end, `gap before played bar ${i + 1}`);
  }
});

test("metadata and tracks come through", () => {
  const { chart } = load();
  assert.equal(chart.title, "Better");
  assert.equal(chart.artist, "Screaming Jets");
  assert.equal(chart.source, "import");

  // Three string tracks; the drum track is not a highway track.
  assert.deepEqual(chart.tracks.map((t) => t.name), ["Grant", "Izzy", "Paul"]);
  const bass = chart.tracks.find((t) => t.name === "Paul")!;
  assert.equal(bass.kind, "bass");
  assert.deepEqual(bass.tuning?.strings, [28, 33, 38, 43], "bass tuning low to high");

  const guitar = chart.tracks[0];
  assert.deepEqual(guitar.tuning?.strings, [40, 45, 50, 55, 59, 64]);
});

test("every note's string and fret agree with its pitch", () => {
  const { chart } = load();
  for (const track of chart.tracks) {
    const tuning = track.tuning!.strings;
    assert.ok((track.notes?.length ?? 0) > 0, `${track.name} has notes`);
    for (const n of track.notes!) {
      assert.ok(n.string >= 0 && n.string < tuning.length, `${track.name}: string ${n.string}`);
      assert.equal(
        tuning[n.string] + n.fret,
        n.midi,
        `${track.name} @${n.tick}: string ${n.string} fret ${n.fret} should sound ${n.midi}`,
      );
    }
  }
});

test("notes are in played order, so the repeated riff appears twice", () => {
  const { chart } = load();
  const notes = chart.tracks[0].notes!;
  for (let i = 1; i < notes.length; i++) {
    assert.ok(notes[i].tick >= notes[i - 1].tick, "sorted by tick");
  }
  // Bars 8-11 are played twice back to back (3840 ticks per 4/4 bar). The second
  // pass must contain the same fret sequence as the first.
  const barTicks = 3840;
  const firstPass = notes.filter((n) => n.tick >= 8 * barTicks && n.tick < 12 * barTicks);
  const secondPass = notes.filter((n) => n.tick >= 12 * barTicks && n.tick < 16 * barTicks);
  assert.ok(firstPass.length > 0);
  assert.deepEqual(
    secondPass.map((n) => `${n.string}:${n.fret}`),
    firstPass.map((n) => `${n.string}:${n.fret}`),
  );
});

test("the tempo change is honoured and the length matches the song", () => {
  const { chart } = load();
  assert.deepEqual(chart.tempos.map((t) => t.bpm), [100, 104]);

  const timing = new TickMap(chart.scoreTiming!);
  const lastTick = chart.scoreTiming![chart.scoreTiming!.length - 1].tick;
  const seconds = timing.tickToMs(lastTick) / 1000;
  // 3:43 when played through — within a second of alphaTab's own tempo maths.
  assert.ok(Math.abs(seconds - 222.9) < 1, `duration ${seconds.toFixed(1)}s`);

  // Before the change, a 4/4 bar at 100 BPM is 2.4 s.
  assert.ok(Math.abs(timing.tickToMs(3840) - 2400) < 1);
});

test("chord names, sections and a beat grid are extracted", () => {
  const { chart } = load();

  const symbols = new Set(chart.chords.map((c) => c.symbol));
  for (const s of ["A5", "A", "D", "E", "C", "G", "F#m", "Asus2"]) {
    assert.ok(symbols.has(s), `chord ${s} present (got ${[...symbols].join(", ")})`);
  }
  // Consecutive duplicates are merged into one held chord.
  for (let i = 1; i < chart.chords.length; i++) {
    assert.notEqual(chart.chords[i].symbol, chart.chords[i - 1].symbol);
  }

  const labels = chart.sections.map((s) => s.label);
  assert.equal(labels[0], "Drum Intro");
  assert.ok(labels.includes("Chorus"));
  assert.ok(labels.includes("Solo"));

  // The song ends on a 6/4 bar and a 5/4 bar, so it is NOT 93 x 4. Beats per bar must
  // follow each bar's own time signature.
  const { score, settings } = load();
  const bars = playbackBars(alphaTab as unknown as AlphaTabModule, score as never, settings);
  const expected = bars.reduce((sum, b) => sum + b.masterBar.timeSignatureNumerator, 0);
  assert.equal(expected, 93 * 4 + 3, "91 bars of 4/4, one of 6/4, one of 5/4");
  assert.equal(chart.beatGrid!.beats.length, expected);
  assert.equal(chart.beatGrid!.beats[0].beatInBar, 1);
});

test("a harmonic keeps its fretted pitch, and is marked as a harmonic", () => {
  // Izzy, bar 52: an artificial harmonic at string 4, fret 7. alphaTab reports the
  // sounding pitch (69); the chart must store the fretted pitch (57) so re-fretting for
  // a new tuning or capo puts it back on fret 7, not an octave away.
  const { chart } = load();
  const izzy = chart.tracks.find((t) => t.name === "Izzy")!;
  const harmonics = izzy.notes!.filter((n) => n.techniques?.includes("harmonic"));
  assert.ok(harmonics.length >= 1, "the harmonic is tagged");
  for (const h of harmonics) {
    assert.equal(izzy.tuning!.strings[h.string] + h.fret, h.midi);
  }
});

test("an unset key signature does not claim C major", () => {
  const { chart } = load();
  assert.deepEqual(chart.keys, [], "zero sharps/flats usually means unset in tabs");
});

test("the initial alignment is the file's own timing", () => {
  const { chart } = load();
  assert.deepEqual(
    chart.syncSets[0].points.map((p) => [p.tick, p.mediaMs]),
    chart.scoreTiming!.map((p) => [p.tick, p.mediaMs]),
  );
});

nodeTest("power chords written as 'no 3rd' become 5 chords", () => {
  assert.equal(normaliseChordName("A (no 3rd)"), "A5");
  assert.equal(normaliseChordName("F# no3"), "F#5");
  assert.equal(normaliseChordName(" C#m7 "), "C#m7");
  assert.equal(normaliseChordName("D/F#"), "D/F#");
});

test("the song's own title and artist override the file's", () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const settings = new alphaTab.Settings();
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  const chart = scoreToChart(alphaTab as unknown as AlphaTabModule, score as never, {
    recording: { transport: "youtube", id: "9NPv_ZsMgIg" },
    fileName: "better.gp5",
    fileSize: bytes.length,
    settings,
    id: "fixed-id",
    title: "Better",
    artist: "The Screaming Jets",
  });
  assert.equal(chart.id, "fixed-id");
  assert.equal(chart.artist, "The Screaming Jets");
});
