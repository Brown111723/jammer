/**
 * Chord-sheet parser.
 *
 * You find a chord sheet wherever you like, copy the text, paste it in. Jammer turns
 * it into a chart you can sync to a recording — which is the part no chord site does.
 *
 * Jammer never fetches from those sites itself. Their catalogues are licensed from
 * publishers and their terms forbid automated access; a scraper would also break every
 * few weeks as they change their markup to stop exactly that. You copying a page you
 * are already looking at is a different thing entirely.
 *
 * TWO FORMATS COVER ALMOST EVERYTHING
 * -----------------------------------
 *   Chords-above-lyrics (Ultimate Guitar, e-chords, most of the web):
 *       C              G
 *       Somebody once told me
 *
 *   ChordPro (inline brackets, used by songbook apps):
 *       [C]Somebody once [G]told me
 *
 * The hard part is the first one, because deciding whether a line is chords or lyrics
 * is a guess. "A" is a valid chord and also a word. "Am I ready" parses as three
 * chords if you squint. The heuristics below are tuned to fail toward *lyrics*, since
 * a missed chord is obvious to the user while a lyric line silently eaten as chords
 * corrupts the whole sheet.
 */

const CHORD_PATTERN =
  /^[A-G](?:#|b)?(?:maj|min|m|M|aug|dim|sus|add|°|ø)?\d*(?:(?:#|b|add|sus|maj|dim|aug|no)\d+)*(?:\/[A-G](?:#|b)?)?$/;

/** Things that appear on a chord line but aren't chords. */
const CHORD_LINE_EXTRAS = new Set([
  "N.C.", "NC", "|", "||", "|:", ":|", "x2", "x3", "x4", "x5", "x6", "x8",
  "(x2)", "(x3)", "(x4)", "-", "/", "//", "///", "////", "%",
]);

export interface SheetChord {
  symbol: string;
  /** Column in the source chord line — lets us render chords over the right syllable. */
  column: number;
}

export interface SheetLine {
  lyrics: string;
  chords: SheetChord[];
}

export interface SheetSection {
  label?: string;
  lines: SheetLine[];
}

export interface ParsedChordSheet {
  sections: SheetSection[];
  /** Every chord in order — this is what gets timed. */
  sequence: { symbol: string; sectionLabel?: string; lyricHint?: string }[];
  format: "chords-above" | "chordpro" | "unknown";
  /** Metadata some sheets carry in a header. */
  title?: string;
  artist?: string;
  key?: string;
  capo?: number;
  tuning?: string;
  /** Distinct chords used, for a quick "do I know these shapes?" glance. */
  distinctChords: string[];
  warnings: string[];
}

export function isChordToken(token: string): boolean {
  if (!token) return false;
  if (CHORD_LINE_EXTRAS.has(token)) return true;
  // Strip decorations that often ride along: (C), C|, |C
  const cleaned = token.replace(/^[|(]+|[|)]+$/g, "");
  if (!cleaned) return true;
  return CHORD_PATTERN.test(cleaned);
}

/** Just the real chords from a chord line, ignoring bar lines and repeat marks. */
function chordsInLine(line: string): SheetChord[] {
  const out: SheetChord[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(line)) !== null) {
    const raw = match[0];
    if (CHORD_LINE_EXTRAS.has(raw)) continue;
    const cleaned = raw.replace(/^[|(]+|[|)]+$/g, "");
    if (!cleaned || !CHORD_PATTERN.test(cleaned)) continue;
    out.push({ symbol: cleaned, column: match.index });
  }
  return out;
}

/**
 * Is this line chords rather than lyrics?
 *
 * Every token must look like a chord, and then one of:
 *  - two or more chords on the line (very unlikely to be a lyric)
 *  - a single chord on a line that is mostly whitespace (chords are positioned)
 *  - a single chord where the token is unambiguous (has a quality: Am, F#m7, not "A")
 *
 * A bare "A" or "I" on its own line stays a lyric. That's the right trade: those are
 * words far more often than they're chords.
 */
export function isChordLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Section markers are handled separately.
  if (/^\[.+\]$/.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  if (!tokens.every(isChordToken)) return false;

  const real = chordsInLine(line);
  if (real.length === 0) return false;
  if (real.length >= 2) return true;

  // Single chord: require it to be more than a bare letter, or clearly positioned.
  const only = real[0].symbol;
  if (only.length > 1) return true;
  return line.length - trimmed.length >= 2;
}

const SECTION_PATTERNS = [
  /^\[([^\]]+)\]$/,
  /^\(([^)]+)\)$/,
  /^((?:intro|verse|chorus|pre-?chorus|bridge|solo|outro|interlude|refrain|breakdown|hook|coda|instrumental|riff|ending|tag)\b[^:]*):?$/i,
];

function sectionLabel(line: string): string | null {
  const trimmed = line.trim();
  for (const pattern of SECTION_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) return match[1].trim();
  }
  return null;
}

/** ChordPro directives and common header lines. */
function parseMetadata(text: string): Partial<ParsedChordSheet> {
  const meta: Partial<ParsedChordSheet> = {};

  const directive = (name: string) =>
    new RegExp(`\\{\\s*(?:${name})\\s*:\\s*([^}]+)\\}`, "i").exec(text)?.[1]?.trim();

  meta.title = directive("title|t");
  meta.artist = directive("artist|subtitle|st|composer");
  meta.key = directive("key");

  const capoDirective = directive("capo");
  if (capoDirective) {
    const n = parseInt(capoDirective, 10);
    if (Number.isFinite(n)) meta.capo = n;
  }

  // Plain-text headers, as most web sheets have.
  if (!meta.capo) {
    const capo = /^\s*capo\s*:?\s*(?:fret\s*)?(\d+)/im.exec(text);
    if (capo) meta.capo = Number(capo[1]);
    else if (/^\s*capo\s*:?\s*(none|no capo)/im.test(text)) meta.capo = 0;
  }
  if (!meta.key) {
    const key = /^\s*key\s*:?\s*([A-G](?:#|b)?m?)\s*$/im.exec(text);
    if (key) meta.key = key[1];
  }

  const tuning = /^\s*tuning\s*:?\s*(.+)$/im.exec(text);
  if (tuning) meta.tuning = tuning[1].trim();

  return meta;
}

/** ChordPro: [C]inline [G]brackets. */
function parseChordPro(text: string): ParsedChordSheet {
  const sections: SheetSection[] = [];
  let current: SheetSection = { lines: [] };
  const warnings: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    // Directives are metadata, already handled; skip them here.
    if (/^\s*\{.*\}\s*$/.test(raw)) {
      const soc = /\{\s*(?:start_of_(\w+)|soc|sov|sob)\s*(?::\s*([^}]+))?\}/i.exec(raw);
      if (soc) {
        if (current.lines.length) sections.push(current);
        current = { label: (soc[2] ?? soc[1] ?? "").trim() || undefined, lines: [] };
      }
      continue;
    }

    const label = sectionLabel(raw);
    if (label) {
      if (current.lines.length) sections.push(current);
      current = { label, lines: [] };
      continue;
    }

    if (!raw.trim()) continue;

    const chords: SheetChord[] = [];
    let lyrics = "";
    const re = /\[([^\]]*)\]|([^[]+)/g;
    let match: RegExpExecArray | null;

    while ((match = re.exec(raw)) !== null) {
      if (match[1] !== undefined) {
        const symbol = match[1].trim();
        if (symbol && (CHORD_PATTERN.test(symbol) || CHORD_LINE_EXTRAS.has(symbol))) {
          chords.push({ symbol, column: lyrics.length });
        }
      } else if (match[2]) {
        lyrics += match[2];
      }
    }

    current.lines.push({ lyrics: lyrics.trimEnd(), chords });
  }

  if (current.lines.length) sections.push(current);

  return finish(sections, "chordpro", warnings, parseMetadata(text));
}

/** The common web format: a chord line, then the lyric line it sits over. */
function parseChordsAbove(text: string): ParsedChordSheet {
  const sections: SheetSection[] = [];
  const warnings: string[] = [];
  let current: SheetSection = { lines: [] };

  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];

    const label = sectionLabel(raw);
    if (label) {
      if (current.lines.length) sections.push(current);
      current = { label, lines: [] };
      i++;
      continue;
    }

    // Skip header/metadata lines so they don't become lyrics.
    if (/^\s*(capo|key|tuning|tempo|bpm|difficulty|author|tabbed by)\s*:/i.test(raw)) {
      i++;
      continue;
    }

    if (!raw.trim()) {
      i++;
      continue;
    }

    if (isChordLine(raw)) {
      const chords = chordsInLine(raw);
      const next = lines[i + 1];

      // A chord line followed by lyrics pairs with them. Two chord lines in a row
      // (an intro riff, say) each stand alone.
      if (next !== undefined && next.trim() && !isChordLine(next) && !sectionLabel(next)) {
        current.lines.push({ lyrics: next.trimEnd(), chords });
        i += 2;
      } else {
        current.lines.push({ lyrics: "", chords });
        i += 1;
      }
      continue;
    }

    // Plain lyrics with no chords above.
    current.lines.push({ lyrics: raw.trimEnd(), chords: [] });
    i++;
  }

  if (current.lines.length) sections.push(current);

  return finish(sections, "chords-above", warnings, parseMetadata(text));
}

function finish(
  sections: SheetSection[],
  format: ParsedChordSheet["format"],
  warnings: string[],
  meta: Partial<ParsedChordSheet>,
): ParsedChordSheet {
  const sequence: ParsedChordSheet["sequence"] = [];

  for (const section of sections) {
    for (const line of section.lines) {
      for (const chord of line.chords) {
        sequence.push({
          symbol: chord.symbol,
          sectionLabel: section.label,
          // A few words of the lyric under the chord, so the timing pass shows you
          // where you are in the song rather than a bare chord name.
          lyricHint: line.lyrics ? lyricHintAt(line.lyrics, chord.column) : undefined,
        });
      }
    }
  }

  if (sequence.length === 0) {
    warnings.push(
      "No chords found. If you pasted a tab (fret numbers on six lines) rather than a " +
        "chord sheet, that isn't supported yet — look for the 'Chords' version.",
    );
  }

  return {
    sections,
    sequence,
    format,
    distinctChords: [...new Set(sequence.map((s) => s.symbol))],
    warnings,
    ...meta,
  };
}

/**
 * A few words of lyric from where the chord sits, cut at a word boundary.
 *
 * Slicing at a fixed character count leaves things like "Today is gonna be the da",
 * which reads as a rendering bug during the timing pass.
 */
function lyricHintAt(lyrics: string, column: number, maxChars = 28): string | undefined {
  let start = Math.max(0, Math.min(column, lyrics.length));

  // A chord frequently sits over the middle of a word ("gon[G]na"). Back up to the
  // start of that word, or the hint reads as garbage: "a be the day..."
  while (start > 0 && !/\s/.test(lyrics[start - 1])) start--;

  const from = lyrics.slice(start).trimStart();
  if (!from) return undefined;
  if (from.length <= maxChars) return from;

  const cut = from.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 8 ? cut.slice(0, lastSpace) : cut) + "\u2026";
}

export function parseChordSheet(text: string): ParsedChordSheet {
  if (!text.trim()) {
    return {
      sections: [],
      sequence: [],
      format: "unknown",
      distinctChords: [],
      warnings: ["Nothing pasted."],
    };
  }

  // Inline brackets containing chords mean ChordPro. Check a decent sample, because
  // some sheets open with a plain-text header before the first bracket.
  const bracketed = text.match(/\[([^\]]{1,10})\]/g) ?? [];
  const chordBrackets = bracketed.filter((b) => {
    const inner = b.slice(1, -1).trim();
    return CHORD_PATTERN.test(inner);
  });

  // Section markers like [Verse] are brackets too, so require the chord-like ones to
  // dominate before calling it ChordPro.
  if (chordBrackets.length >= 4 && chordBrackets.length > bracketed.length * 0.5) {
    return parseChordPro(text);
  }

  return parseChordsAbove(text);
}

/** Collapse immediate repeats — "C C C G" becomes "C G" for the timing pass. */
export function collapseRepeats(
  sequence: ParsedChordSheet["sequence"],
): ParsedChordSheet["sequence"] {
  const out: ParsedChordSheet["sequence"] = [];
  for (const chord of sequence) {
    if (out.length === 0 || out[out.length - 1].symbol !== chord.symbol) {
      out.push(chord);
    }
  }
  return out;
}
