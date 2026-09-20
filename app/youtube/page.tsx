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
  classifyLink,
  getPlaylist,
  getPlaylistTracks,
  parseStartSeconds,
  searchAvailable,
  searchVideos,
  YouTubeQuotaError,
  type PlaylistInfo,
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
  const [album, setAlbum] = useState<PlaylistInfo | null>(null);
  const [albumTracks, setAlbumTracks] = useState<YouTubeVideo[]>([]);
  const [albumLoading, setAlbumLoading] = useState(false);

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

  const submitPaste = useCallback(async () => {
    setPasteError(null);
    setAlbum(null);
    setAlbumTracks([]);

    const link = classifyLink(paste);
    if (!link) {
      setPasteError(
        "That doesn't look like a YouTube link. A song link, an album link or a " +
          "playlist link from YouTube Music all work.",
      );
      return;
    }

    // A song link goes straight to the jam page.
    if (link.kind === "video") {
      open(link.id, paste, parseStartSeconds(paste));
      return;
    }

    // An album or playlist expands into a track list to pick from. YouTube Music
    // album pages are playlists underneath (list=OLAK5uy_...).
    if (!searchAvailable()) {
      setPasteError(
        "That's an album or playlist. Expanding one needs a YouTube API key in " +
          "NEXT_PUBLIC_YOUTUBE_API_KEY — see .env.example. Individual song links " +
          "work without it.",
      );
      return;
    }

    setAlbumLoading(true);
    try {
      const [info, tracks] = await Promise.all([
        getPlaylist(link.id),
        getPlaylistTracks(link.id),
      ]);
      if (!info && tracks.length === 0) {
        setPasteError("That playlist is empty, private, or doesn't exist.");
        return;
      }
      setAlbum(info);
      setAlbumTracks(tracks);
    } catch (err) {
      setPasteError(
        err instanceof YouTubeQuotaError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setAlbumLoading(false);
    }
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
          In the YouTube Music app: <strong>Share &rarr; Copy link</strong>. Paste it
          here. A <strong>song</strong>, an <strong>album</strong> or a{" "}
          <strong>playlist</strong> all work &mdash; albums expand into a track list.
          Songs need no sign-in or API key at all.
        </p>
        <div className="yt-paste-row">
          <input
            type="text"
            inputMode="url"
            placeholder="music.youtube.com/watch?v=…"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submitPaste()}
            autoFocus
          />
          <button className="button" onClick={() => void submitPaste()}>
            Jam
          </button>
        </div>
        {pasteError && <p className="warn">{pasteError}</p>}
        {albumLoading && <p className="muted">Loading album&hellip;</p>}
      </section>

      {albumTracks.length > 0 && (
        <section>
          <h2>
            {album?.title ?? "Album"}{" "}
            <span className="muted">
              {album?.channel ? `· ${album.channel} ` : ""}· {albumTracks.length} tracks
            </span>
          </h2>
          <ul className="tracklist">
            {albumTracks.map((v, i) => (
              <li key={`${v.id}-${i}`}>
                <a
                  href={`/jam/youtube/${v.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    open(v.id, v.title);
                  }}
                >
                  <span className="track-number muted">{i + 1}</span>
                  <span className="tracklist-name">{v.title}</span>
                  <span className="tracklist-artist muted">{v.channel}</span>
                  <span />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

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
