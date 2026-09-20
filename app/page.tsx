"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { beginLogin, getStoredTokens, clearTokens } from "../lib/spotify-auth";
import { spotify, type SpotifyProfile } from "../lib/spotify-api";

export default function Home() {
  const [profile, setProfile] = useState<SpotifyProfile | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!getStoredTokens()) {
      setChecking(false);
      return;
    }
    spotify
      .me()
      .then(setProfile)
      .catch(() => clearTokens())
      .finally(() => setChecking(false));
  }, []);

  return (
    <main className="home">
      <h1>Jammer</h1>
      <p className="tagline">
        Tab, chords and lyrics that follow the actual recording you&rsquo;re playing.
      </p>

      <section className="home-card featured">
        <h2>YouTube / YouTube Music</h2>
        <p>
          Paste a link from the YouTube Music app &mdash; <strong>Share &rarr; Copy
          link</strong> &mdash; and start jamming. No sign-in, nothing to set up.
        </p>
        <p className="muted">
          This is also the best transport for practice: YouTube lets Jammer slow the
          track down and keep the chart locked to it. Spotify can&rsquo;t do that at all.
        </p>
        <Link href="/youtube" className="button">
          Open YouTube
        </Link>
      </section>

      <section className="home-card">
        <h2>Start with a local file</h2>
        <p>
          No account needed. Drop in an MP3 and a Guitar Pro file. This is also the only
          mode that can transcribe audio &mdash; streamed audio is DRM-protected and
          can&rsquo;t be analysed.
        </p>
        <Link href="/jam/local" className="button">
          Open local jam
        </Link>
      </section>

      <section className="home-card">
        <h2>Connect Spotify</h2>
        {checking ? (
          <p className="muted">Checking&hellip;</p>
        ) : profile ? (
          <>
            <p>
              Signed in as <strong>{profile.display_name ?? profile.id}</strong>.
            </p>
            {profile.product !== "premium" && (
              <p className="warn">
                This account is <strong>{profile.product ?? "not premium"}</strong>.
                Search and your library will work, but the Web Playback SDK only streams
                on Premium &mdash; playback will silently do nothing. Local-file mode
                works on any account.
              </p>
            )}
            <Link href="/library" className="button">
              Browse your library
            </Link>
            <button
              className="button secondary"
              onClick={() => {
                clearTokens();
                setProfile(null);
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <p>
              Jammer reads your library and controls playback. It never writes to your
              account.
            </p>
            <button className="button" onClick={() => void beginLogin()}>
              Sign in with Spotify
            </button>
          </>
        )}
      </section>

      <footer className="home-footer muted">
        <p>
          Lyrics from <a href="https://lrclib.net">LRCLIB</a>. Playback via the Spotify
          Web Playback SDK. Notation rendered with{" "}
          <a href="https://alphatab.net">alphaTab</a>.
        </p>
      </footer>
    </main>
  );
}
