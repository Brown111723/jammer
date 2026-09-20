"use client";

/**
 * Library + search. Saved tracks, albums, playlists, and a search box.
 *
 * Note what's missing versus a pre-2024 build of this page: there's no "sort by BPM" or
 * "find songs in my key", because /audio-features is gone. Those features now depend on
 * having analysed the track, so they live downstream of the analyzer rather than being
 * free metadata.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  albumArt,
  artistNames,
  spotify,
  type SpotifyTrack,
} from "../../lib/spotify-api";
import { getStoredTokens } from "../../lib/spotify-auth";

type Tab = "saved" | "top" | "search";

export default function LibraryPage() {
  const [tab, setTab] = useState<Tab>("saved");
  const [tracks, setTracks] = useState<SpotifyTrack[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (which: Tab, q = "") => {
    setLoading(true);
    setError(null);
    try {
      if (which === "saved") {
        const page = await spotify.savedTracks(50);
        setTracks(page.items.map((i) => i.track));
      } else if (which === "top") {
        const page = await spotify.topTracks(50);
        setTracks(page.items);
      } else if (q.trim()) {
        const res = await spotify.search(q, ["track"], 30);
        setTracks(res.tracks?.items ?? []);
      } else {
        setTracks([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getStoredTokens()) {
      setError("Not signed in.");
      return;
    }
    void load("saved");
  }, [load]);

  // Debounce search so we're not hammering the API on every keystroke.
  useEffect(() => {
    if (tab !== "search") return;
    const id = setTimeout(() => void load("search", query), 300);
    return () => clearTimeout(id);
  }, [query, tab, load]);

  return (
    <main className="library">
      <header>
        <Link href="/">← Jammer</Link>
        <nav>
          {(["saved", "top", "search"] as Tab[]).map((t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => {
                setTab(t);
                if (t !== "search") void load(t);
              }}
            >
              {t === "saved" ? "Liked" : t === "top" ? "Top" : "Search"}
            </button>
          ))}
        </nav>
      </header>

      {tab === "search" && (
        <input
          className="search"
          type="search"
          placeholder="Search Spotify…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      )}

      {error && <p className="warn">{error}</p>}
      {loading && <p className="muted">Loading…</p>}

      <ul className="tracklist">
        {tracks.map((t) => (
          <li key={t.id}>
            <Link href={`/jam/spotify/${t.id}`}>
              {albumArt(t.album, 64) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={albumArt(t.album, 64)} alt="" width={48} height={48} />
              )}
              <span className="tracklist-name">{t.name}</span>
              <span className="tracklist-artist muted">{artistNames(t)}</span>
              <span className="tracklist-duration muted">
                {Math.floor(t.duration_ms / 60000)}:
                {String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, "0")}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {!loading && tracks.length === 0 && !error && (
        <p className="muted">Nothing here yet.</p>
      )}
    </main>
  );
}
