"use client";

/**
 * Links to the chord and tab sites, pre-searched for whatever is playing.
 *
 * Jammer knows the artist and title already, so these aren't bookmarks — one tap lands
 * on the search results for this exact song. Copy a sheet, come back, paste it into
 * the importer.
 *
 * WHY LINKS AND NOT A SCRAPER
 * ---------------------------
 * Ultimate Guitar and Songsterr license their catalogues from music publishers and
 * their terms forbid automated access. A scraper is both a legal liability for whoever
 * hosts it and, practically, a maintenance treadmill — those sites change their markup
 * specifically to break them.
 *
 * Linking is what they're built for. You reading a page and copying from it is your
 * own use of a page you're already looking at, which is an entirely different act from
 * an app harvesting their database.
 *
 * ON "BEST RATED": the star ratings are a poor signal for playing along. Top-rated
 * sheets skew simplified, and are often transposed or capo'd for singing rather than
 * matched to the recording. Picking by eye takes five seconds and does better.
 */

export interface ChordSourcesProps {
  title: string;
  artist: string;
  onPaste?: () => void;
  compact?: boolean;
}

interface Source {
  name: string;
  build: (query: string, title: string, artist: string) => string;
  note?: string;
}

const SOURCES: Source[] = [
  {
    name: "Ultimate Guitar",
    build: (q) =>
      `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}`,
    note: "Chords and tabs, biggest catalogue",
  },
  {
    name: "Songsterr",
    build: (q) => `https://www.songsterr.com/?pattern=${q}`,
    note: "Interactive tab, good for riffs",
  },
  {
    name: "e-chords",
    build: (q) => `https://www.e-chords.com/search-all/${q}`,
    note: "Often cleaner plain-text sheets",
  },
  {
    name: "Chordie",
    build: (q) => `https://www.chordie.com/results.php?q=${q}`,
    note: "Aggregates several sources",
  },
];

export function ChordSources({
  title,
  artist,
  onPaste,
  compact = false,
}: ChordSourcesProps) {
  // Strip the video-title noise, or the search finds nothing.
  const cleanTitle = title
    .replace(
      /[([]\s*(official\s*)?(music\s*)?(lyric\s*)?(video|audio|visualizer|hd|4k|remaster(ed)?(\s*\d{4})?|explicit|clean|mv)\s*[)\]]/gi,
      "",
    )
    .trim();
  const cleanArtist = artist.replace(/\s*-\s*topic$/i, "").trim();

  const query = encodeURIComponent(
    [cleanArtist, cleanTitle].filter(Boolean).join(" ").trim(),
  );

  if (!query) return null;

  return (
    <div className={compact ? "chordsources compact" : "chordsources"}>
      <span className="chordsources-label">Find chords</span>

      <div className="chordsources-links">
        {SOURCES.map((source) => (
          <a
            key={source.name}
            href={source.build(query, cleanTitle, cleanArtist)}
            target="_blank"
            rel="noopener noreferrer"
            title={source.note}
          >
            {source.name}
          </a>
        ))}
      </div>

      {onPaste && (
        <button className="chordsources-paste" onClick={onPaste}>
          Paste a chord sheet
        </button>
      )}
    </div>
  );
}
