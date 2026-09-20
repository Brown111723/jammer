"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { completeLogin } from "../../lib/spotify-auth";

function Callback() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const denied = params.get("error");
    if (denied) {
      setError(
        denied === "access_denied"
          ? "You declined the permission request. Jammer can't read your library without it."
          : denied,
      );
      return;
    }

    const code = params.get("code");
    if (!code) {
      setError("No authorization code in the callback URL.");
      return;
    }

    completeLogin(code)
      .then(() => router.replace("/library"))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [router]);

  if (error) {
    return (
      <main className="callback">
        <h1>Sign-in failed</h1>
        <p className="warn">{error}</p>
        <p className="muted">
          A common cause: the redirect URI registered in your Spotify dashboard must be
          exactly <code>http://127.0.0.1:3000/callback</code>. Spotify no longer accepts
          the hostname <code>localhost</code>.
        </p>
        <a href="/">Back to start</a>
      </main>
    );
  }

  return (
    <main className="callback">
      <p>Signing you in&hellip;</p>
    </main>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={<main className="callback">Loading&hellip;</main>}>
      <Callback />
    </Suspense>
  );
}
