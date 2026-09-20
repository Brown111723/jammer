"use client";

/**
 * Signed-in YouTube library: playlists (including the ones made in YouTube Music),
 * liked music, and drilling into a playlist.
 *
 * The one piece of honesty that matters here: when "Liked Music" falls back to liked
 * *videos*, say so. They overlap heavily for YouTube Music users but they are not the
 * same list, and silently substituting one for the other is the kind of small lie that
 * makes people distrust everything else in an app.
 */

import { useCallback, useEffect, useState } from "react";
import {
  beginYouTubeLogin,
  clearYouTubeTokens,
  isYouTubeSignedIn,
  youtubeSignInAvailable,
} from "../lib/google-auth";
import {
  likedMusic,
  myPlaylists,
  NotSignedInError,
  playlistTracks,
  type Playlist,
} from "../lib/youtube-library";
import type { YouTubeVideo } from "../lib/youtube";

export interface YouTubeLibraryProps {
  onPick: (video: YouTubeVideo) => void;
}

type View =
  | { kind: "playlists" }
  | { kind: "playlist"; playlist: Playlist }
  | { kind: "liked" };

export function YouTubeLibrary({ onPick }: YouTubeLibraryProps) {
  const [signedIn, setSignedIn] = useState(false);
  const [view, setView] = useState<View>({ kind: "playlists" });
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [tracks, setTracks] = useState<YouTubeVideo[]>([]);
  const [likedSource, setLikedSource] = useState<"LM" | "likedVideos" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = youtubeSignInAvailable();

  useEffect(() => setSignedIn(isYouTubeSignedIn()), []);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof NotSignedInError) {
        clearYouTubeTokens();
        setSignedIn(false);
        setError("Your session expired. Sign in again.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void guard(async () => setPlaylists(await myPlaylists()));
  }, [signedIn, guard]);

  const openPlaylist = useCallback(
    (playlist: Playlist) => {
      setView({ kind: "playlist", playlist });
      setTracks([]);
      void guard(async () => setTracks(await playlistTracks(playlist.id)));
    },
    [guard],
  );

  const openLiked = useCallback(() => {
    setView({ kind: "liked" });
    setTracks([]);
    void guard(async () => {
      const { tracks: t, source } = await likedMusic();
      setTracks(t);
      setLikedSource(source);
    });
  }, [guard]);

  if (!configured) {
    return (
      <section>
        <h2>Your library</h2>
        <p className="muted">
          Signing in needs a Google OAuth client. See <code>.env.example</code> for the
          three-minute setup &mdash; it unlocks your playlists and liked music. Pasting
          links works without it.
        </p>
      </section>
    );
  }

  if (!signedIn) {
    return (
      <section>
        <h2>Your library</h2>
        <p className="muted">
          Sign in to see your YouTube Music playlists and liked songs. Jammer requests
          read-only access and never writes to your account.
        </p>
        <button className="button" onClick={() => void beginYouTubeLogin()}>
          Sign in with Google
        </button>
      </section>
    );
  }

  return (
    <section>
      <div className="yt-lib-head">
        <h2>Your library</h2>
        <button
          className="button secondary small"
          onClick={() => {
            clearYouTubeTokens();
            setSignedIn(false);
            setPlaylists([]);
            setTracks([]);
          }}
        >
          Sign out
        </button>
      </div>

      <nav className="yt-lib-tabs">
        <button
          className={view.kind === "playlists" ? "active" : ""}
          onClick={() => setView({ kind: "playlists" })}
        >
          Playlists
        </button>
        <button className={view.kind === "liked" ? "active" : ""} onClick={openLiked}>
          Liked
        </button>
        {view.kind === "playlist" && (
          <button className="active">{view.playlist.title}</button>
        )}
      </nav>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="warn">{error}</p>}

      {view.kind === "playlists" && !loading && (
        <>
          {playlists.length === 0 && !error && (
            <p className="muted">
              No playlists found. Playlists you create in YouTube Music show up here;
              auto-generated ones like &ldquo;Liked Music&rdquo; don&rsquo;t &mdash; use
              the Liked tab for those.
            </p>
          )}
          <ul className="tracklist">
            {playlists.map((p) => (
              <li key={p.id}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    openPlaylist(p);
                  }}
                >
                  {p.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumbnail} alt="" width={48} height={36} />
                  ) : (
                    <span />
                  )}
                  <span className="tracklist-name">{p.title}</span>
                  <span className="tracklist-artist muted">
                    {p.itemCount} track{p.itemCount === 1 ? "" : "s"}
                  </span>
                  <span />
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {(view.kind === "playlist" || view.kind === "liked") && !loading && (
        <>
          {view.kind === "liked" && likedSource === "likedVideos" && (
            <p className="muted small">
              Showing your <strong>liked videos</strong>. YouTube Music&rsquo;s
              &ldquo;Liked Music&rdquo; is an auto-playlist no official API exposes, but
              liking a song in YT Music also likes the video, so these overlap heavily.
            </p>
          )}
          {view.kind === "liked" && likedSource === "LM" && (
            <p className="muted small">
              Straight from your YouTube Music <strong>Liked Music</strong> playlist.
            </p>
          )}
          <ul className="tracklist">
            {tracks.map((v) => (
              <li key={v.id}>
                <a
                  href={`/jam/youtube/${v.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onPick(v);
                  }}
                >
                  {v.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbnail} alt="" width={48} height={36} />
                  ) : (
                    <span />
                  )}
                  <span className="tracklist-name">{v.title}</span>
                  <span className="tracklist-artist muted">{v.channel}</span>
                  <span />
                </a>
              </li>
            ))}
          </ul>
          {tracks.length === 0 && !error && <p className="muted">Nothing here.</p>}
        </>
      )}
    </section>
  );
}
