"use client";

/**
 * YouTube / YouTube Music entry point.
 *
 * Paste-a-link is the primary path, not a fallback. A YouTube Music share link carries
 * the same video ID the IFrame player needs, so Share → Copy link in the YT Music app
 * lands you straight here with no auth, no API key and no quota. Nothing built on an
 * API is as reliable as that.
 *
 * Search is offered second, because it needs an API key and burns 100 of the 10,000
 * daily quota units per query — about 100 searches a day.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { YouTubeLibrary } from "../../components/YouTubeLibrary";
import {
  parseStartSeconds,
  parseVideoId,
  searchAvailable,
  searchVideos,
  YouTubeQuotaError,
  type YouTubeVideo,
} from "../../lib/youtube";

const RECENT_KEY = "jammer.youtube.recent";

interface RecentEntry {
  id: string;
  title: string;
  at: string;
}

export default function YouTubePage() {
  const router = useRouter();
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YouTubeVideo[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentEntry[]>([]);

  const hasKey = searchAvailable();

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"));
    } catch {
      setRecent([]);
    }
  }, []);

  const open = useCallback(
    (id: string, title: string, startSec = 0) => {
      try {
        const next = [
          { id, title, at: new Date().toISOString() },
          ...recent.filter((r) => r.id !== id),
        ].slice(0, 12);
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* storage is a nicety here */
      }
      router.push(`/jam/youtube/${id}${startSec ? `?t=${startSec}` : ""}`);
    },
    [recent, router],
  );

  const submitPaste = useCallback(() => {
    setPasteError(null);
    const id = parseVideoId(paste);
    if (!id) {
      setPasteError(
        "That doesn't look like a YouTube link or video ID. A YouTube Music link " +
          "(music.youtube.com/watch?v=…) works too.",
      );
      return;
    }
    open(id, paste, parseStartSeconds(paste));
  }, [paste, open]);

  const runSearch = useCallback(async () => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await searchVideos(query, 20));
    } catch (err) {
      setResults([]);
      setSearchError(
        err instanceof YouTubeQuotaError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setSearching(false);
    }
  }, [query]);

  return (
    <main className="library">
      <header>
        <Link href="/">← Jammer</Link>
        <h1>YouTube Music</h1>
      </header>

      <section className="yt-paste">
        <h2>Paste a link</h2>
        <p className="muted">
          In the YouTube Music app: <strong>Share → Copy link</strong>. Paste it here.
          No sign-in, no API key, nothing to set up &mdash; a YouTube Music link and a
          YouTube link carry the same video ID.
        </p>
        <div className="yt-paste-row">
          <input
            type="text"
            inputMode="url"
            placeholder="music.youtube.com/watch?v=…"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitPaste()}
            autoFocus
          />
          <button className="button" onClick={submitPaste}>
            Jam
          </button>
        </div>
        {pasteError && <p className="warn">{pasteError}</p>}
      </section>

      <YouTubeLibrary onPick={(v) => open(v.id, v.title)} />

      {recent.length > 0 && (
        <section>
          <h2>Recent</h2>
          <ul className="tracklist">
            {recent.map((r) => (
              <li key={r.id}>
                <a
                  onClick={(e) => {
                    e.preventDefault();
                    open(r.id, r.title);
                  }}
                  href={`/jam/youtube/${r.id}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`https://i.ytimg.com/vi/${r.id}/default.jpg`}
                    alt=""
                    width={48}
                    height={36}
                  />
                  <span className="tracklist-name">{r.title}</span>
                  <span />
                  <span />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Search</h2>
        {hasKey ? (
          <>
            <div className="yt-paste-row">
              <input
                type="search"
                placeholder="Song or artist…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void runSearch()}
              />
              <button className="button" onClick={() => void runSearch()}>
                Search
              </button>
            </div>
            <p className="muted small">
              Results are filtered to the Music category and to embeddable videos, so
              reaction uploads and blocked official videos don&rsquo;t clutter them.
            </p>
          </>
        ) : (
          <p className="muted">
            Search needs a YouTube Data API key in{" "}
            <code>NEXT_PUBLIC_YOUTUBE_API_KEY</code>. It&rsquo;s free from the{" "}
            <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">
              Google Cloud console
            </a>
            . Pasting links works without one.
          </p>
        )}

        {searching && <p className="muted">Searching…</p>}
        {searchError && <p className="warn">{searchError}</p>}

        <ul className="tracklist">
          {results.map((v) => (
            <li key={v.id}>
              <a
                href={`/jam/youtube/${v.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  open(v.id, v.title);
                }}
              >
                {v.thumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.thumbnail} alt="" width={64} height={36} />
                )}
                <span className="tracklist-name">{v.title}</span>
                <span className="tracklist-artist muted">{v.channel}</span>
                <span />
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="yt-note">
        <h2>What Jammer can and can&rsquo;t see</h2>
        <p className="muted">
          There is no official YouTube Music API. Playing any track works, and so does
          search. Your own YouTube Music <em>playlists</em> are backed by ordinary
          YouTube playlists, so those are reachable once playlist sign-in is added.
          Your <strong>Liked Music</strong> is a YouTube Music-only auto-playlist that
          no official API exposes &mdash; copy it into a normal playlist if you want it
          here.
        </p>
        <p className="muted">
          Unlike Spotify, YouTube lets Jammer change the playback speed, so you can
          work a solo at 70% and the chart stays locked to it.
        </p>
      </section>
    </main>
  );
}
