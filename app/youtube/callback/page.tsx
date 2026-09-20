"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { completeYouTubeLogin } from "../../../lib/google-auth";

function Callback() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const denied = params.get("error");
    if (denied) {
      setError(
        denied === "access_denied"
          ? "You declined the permission request. Jammer can't read your playlists without it — pasting links still works."
          : denied,
      );
      return;
    }

    const code = params.get("code");
    if (!code) {
      setError("No authorization code in the callback URL.");
      return;
    }

    completeYouTubeLogin(code)
      .then(() => router.replace("/youtube"))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [router]);

  if (error) {
    return (
      <main className="callback">
        <h1>YouTube sign-in failed</h1>
        <p className="warn">{error}</p>
        <p className="muted">
          Check that <code>http://127.0.0.1:3000/youtube/callback</code> is listed as an
          authorised redirect URI on your OAuth client in the Google Cloud console, and
          that the YouTube Data API v3 is enabled for the project.
        </p>
        <a href="/youtube">Back to YouTube</a>
      </main>
    );
  }

  return (
    <main className="callback">
      <p>Signing you in&hellip;</p>
    </main>
  );
}

export default function YouTubeCallbackPage() {
  return (
    <Suspense fallback={<main className="callback">Loading&hellip;</main>}>
      <Callback />
    </Suspense>
  );
}
