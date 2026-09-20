import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseChordSheet,
  isChordLine,
  isChordToken,
  collapseRepeats,
} from "../lib/chord-sheet.ts";

test("recognises chord symbols, including the awkward ones", () => {
  for (const good of [
    "C", "Am", "F#m7", "Bb", "C/G", "Dsus4", "G7", "Cmaj7", "Am7", "Ebmaj7",
    "F#m7b5", "Csus2", "Aadd9", "Bbm", "D/F#", "Gmaj7", "C#dim", "Faug",
  ]) {
    assert.ok(isChordToken(good), `${good} should be a chord`);
  }

  for (const bad of ["Hello", "the", "world", "H", "Xm", "gonna", "1234"]) {
    assert.ok(!isChordToken(bad), `${bad} should not be a chord`);
  }
});

test("chord lines are distinguished from lyric lines", () => {
  assert.ok(isChordLine("C              G"));
  assert.ok(isChordLine("Am    F    C    G"));
  assert.ok(isChordLine("  Dsus4   D"));
  assert.ok(isChordLine("F#m7"), "a qualified single chord is unambiguous");

  assert.ok(!isChordLine("Somebody once told me"));
  assert.ok(!isChordLine(""));
  assert.ok(!isChordLine("[Verse 1]"), "section markers are not chord lines");

  // The classic false positive. "A" is a chord AND a word; unindented, treat as lyric.
  assert.ok(!isChordLine("A"), "a bare A at column 0 is probably a word");
  // But positioned like a chord, it is one.
  assert.ok(isChordLine("        A"), "indentation means it was positioned");
});

test("parses the chords-above-lyrics format the web uses", () => {
  const sheet = [
    "[Verse 1]",
    "C                G",
    "Somebody once told me",
    "Am              F",
    "The world is gonna roll me",
    "",
    "[Chorus]",
    "C       G       Am      F",
    "Hey now, you're an all star",
  ].join("\n");

  const parsed = parseChordSheet(sheet);

  assert.equal(parsed.format, "chords-above");
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].label, "Verse 1");
  assert.equal(parsed.sections[1].label, "Chorus");

  assert.deepEqual(
    parsed.sequence.map((c) => c.symbol),
    ["C", "G", "Am", "F", "C", "G", "Am", "F"],
  );

  // Chords must pair with the lyric line beneath them, not float free.
  assert.equal(parsed.sections[0].lines[0].lyrics, "Somebody once told me");
  assert.equal(parsed.sections[0].lines[0].chords.length, 2);
  assert.equal(parsed.sections[0].lines[0].chords[0].column, 0);
  assert.equal(parsed.sections[0].lines[0].chords[1].column, 17);
});

test("parses ChordPro inline brackets", () => {
  const sheet = [
    "{title: All Star}",
    "{artist: Smash Mouth}",
    "{key: C}",
    "",
    "[C]Somebody once [G]told me",
    "[Am]The world is [F]gonna roll me",
  ].join("\n");

  const parsed = parseChordSheet(sheet);

  assert.equal(parsed.format, "chordpro");
  assert.equal(parsed.title, "All Star");
  assert.equal(parsed.artist, "Smash Mouth");
  assert.equal(parsed.key, "C");
  assert.deepEqual(
    parsed.sequence.map((c) => c.symbol),
    ["C", "G", "Am", "F"],
  );
  assert.equal(parsed.sections[0].lines[0].lyrics, "Somebody once told me");
});

test("does not mistake a section-marker-heavy sheet for ChordPro", () => {
  // [Verse] markers are brackets too — they must not trigger the ChordPro path.
  const sheet = [
    "[Intro]", "C G Am F",
    "[Verse 1]", "C              G", "Words here",
    "[Chorus]", "Am    F", "More words",
    "[Bridge]", "C", "Even more",
  ].join("\n");

  const parsed = parseChordSheet(sheet);
  assert.equal(parsed.format, "chords-above");
  assert.equal(parsed.sections.length, 4);
});

test("picks up capo and key from plain-text headers", () => {
  const sheet = [
    "Capo: 2",
    "Key: G",
    "Tuning: Eb Standard",
    "",
    "G        D",
    "Test line",
  ].join("\n");

  const parsed = parseChordSheet(sheet);
  assert.equal(parsed.capo, 2);
  assert.equal(parsed.key, "G");
  assert.equal(parsed.tuning, "Eb Standard");
  // Header lines must not leak into the lyrics.
  const lyrics = parsed.sections.flatMap((s) => s.lines.map((l) => l.lyrics));
  assert.ok(!lyrics.some((l) => l.toLowerCase().includes("capo")));
});

test("handles bar lines and repeat marks on chord lines", () => {
  const parsed = parseChordSheet("| C | G | Am | F | x2");
  assert.deepEqual(
    parsed.sequence.map((c) => c.symbol),
    ["C", "G", "Am", "F"],
    "bar lines and x2 are not chords",
  );
});

test("an intro riff with no lyrics under it still yields chords", () => {
  const parsed = parseChordSheet(["[Intro]", "Am  F  C  G", "Am  F  C  G"].join("\n"));
  assert.equal(parsed.sequence.length, 8);
  assert.equal(parsed.sections[0].lines[0].lyrics, "");
});

test("carries a lyric hint so the timing pass shows where you are", () => {
  const parsed = parseChordSheet(
    ["C                G", "Somebody once told me"].join("\n"),
  );
  assert.ok(parsed.sequence[0].lyricHint?.startsWith("Somebody"));
  assert.ok(parsed.sequence[1].lyricHint, "the second chord lands mid-line");
});

test("reports distinct chords for a shapes-at-a-glance list", () => {
  const parsed = parseChordSheet(
    ["C    G    Am   F", "words", "C    G", "more"].join("\n"),
  );
  assert.deepEqual(parsed.distinctChords, ["C", "G", "Am", "F"]);
});

test("warns rather than silently failing on a six-line tab", () => {
  const tab = [
    "e|---------------------|",
    "B|---------------------|",
    "G|-----2---------------|",
    "D|---2-----------------|",
    "A|-0-------------------|",
    "E|---------------------|",
  ].join("\n");

  const parsed = parseChordSheet(tab);
  assert.equal(parsed.sequence.length, 0);
  assert.ok(parsed.warnings.length > 0);
  assert.match(parsed.warnings[0], /tab/i);
});

test("empty input is handled", () => {
  const parsed = parseChordSheet("");
  assert.equal(parsed.sequence.length, 0);
  assert.ok(parsed.warnings.length > 0);
});

test("collapseRepeats removes consecutive duplicates only", () => {
  const seq = ["C", "C", "C", "G", "G", "Am", "C"].map((symbol) => ({ symbol }));
  assert.deepEqual(
    collapseRepeats(seq).map((c) => c.symbol),
    ["C", "G", "Am", "C"],
    "the final C is a genuine return, not a repeat",
  );
});

test("a realistic messy Ultimate-Guitar-style paste survives", () => {
  const sheet = `
Wonderwall - Oasis
Capo: 2

[Intro]
Em7  G  Dsus4  A7sus4

[Verse 1]
Em7           G
Today is gonna be the day
        Dsus4                A7sus4
That they're gonna throw it back to you

[Chorus]
       C         Em7
Because maybe
          G             Em7
You're gonna be the one that saves me
`;

  const parsed = parseChordSheet(sheet);

  assert.equal(parsed.capo, 2);
  assert.ok(parsed.sequence.length >= 10);
  assert.ok(parsed.distinctChords.includes("Em7"));
  assert.ok(parsed.distinctChords.includes("A7sus4"));
  assert.ok(parsed.distinctChords.includes("Dsus4"));

  // The title line must not be parsed as chords.
  assert.ok(!parsed.distinctChords.includes("Oasis"));

  const labels = parsed.sections.map((s) => s.label);
  assert.ok(labels.includes("Intro"));
  assert.ok(labels.includes("Verse 1"));
  assert.ok(labels.includes("Chorus"));
});

test("lyric hints start and end on whole words", () => {
  const parsed = parseChordSheet(
    [
      "Em7          G",
      "Today is gonna be the day that they will throw it back to you",
    ].join("\n"),
  );

  assert.equal(parsed.sequence.length, 2);

  // The second chord sits over the middle of "gonna" — the hint must back up to the
  // start of that word rather than beginning mid-syllable.
  const second = parsed.sequence[1].lyricHint;
  assert.ok(second);
  assert.ok(
    /^(gonna|be|the)/.test(second),
    `hint should start on a whole word, got "${second}"`,
  );

  const hint = parsed.sequence[0].lyricHint;
  assert.ok(hint);
  assert.ok(hint.startsWith("Today"));
  // Either it fits whole, or it ends at a word with an ellipsis.
  if (hint.endsWith("…")) {
    const words = hint.slice(0, -1);
    assert.ok(!words.endsWith(" "), "no trailing space before the ellipsis");
    assert.ok(
      /\b(Today|is|gonna|be|the|day)$/.test(words),
      `hint should end on a whole word, got "${hint}"`,
    );
  }
});
