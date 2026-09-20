/**
 * Spotify OAuth via PKCE — entirely client-side, no client secret, nothing to leak.
 *
 * Two gotchas that cost people afternoons:
 *
 *  1. Spotify stopped accepting `http://localhost` redirect URIs. Use `http://127.0.0.1`.
 *     Loopback IP literals are still allowed; the hostname `localhost` is not.
 *
 *  2. The Web Playback SDK requires a **Premium** account. On free accounts auth works
 *     fine, search works fine, and playback silently does nothing. Check `product` on
 *     the profile and tell the user plainly rather than letting them debug a dead player.
 */

const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";

const STORAGE_KEY = "jammer.spotify.tokens";
const VERIFIER_KEY = "jammer.spotify.verifier";

/**
 * `streaming` is what the Web Playback SDK needs. The library scopes are read-only.
 * We deliberately do not request any playlist-modify scope — Jammer never writes to
 * anyone's account.
 */
export const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-library-read",
  "playlist-read-private",
  "user-top-read",
] as const;

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

// ---------------------------------------------------------------- PKCE helpers

function base64UrlEncode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomVerifier(length = 64): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join("");
}

async function challengeFrom(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(digest);
}

// ---------------------------------------------------------------- flow

export function clientId(): string {
  const id = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID;
  if (!id) {
    throw new Error(
      "NEXT_PUBLIC_SPOTIFY_CLIENT_ID is not set. Copy .env.example to .env.local " +
        "and add your client ID from https://developer.spotify.com/dashboard",
    );
  }
  return id;
}

export function redirectUri(): string {
  return (
    process.env.NEXT_PUBLIC_SPOTIFY_REDIRECT_URI ??
    `${window.location.origin}/callback`
  );
}

/** Kick off the login redirect. */
export async function beginLogin(): Promise<void> {
  const verifier = randomVerifier();
  const challenge = await challengeFrom(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  window.location.href = `${AUTH_ENDPOINT}?${params}`;
}

/** Call from the /callback route with the `code` query param. */
export async function completeLogin(code: string): Promise<StoredTokens> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) {
    throw new Error(
      "No PKCE verifier in sessionStorage — the login was started in a different tab, " +
        "or storage was cleared. Start the login again.",
    );
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }

  sessionStorage.removeItem(VERIFIER_KEY);
  return store(await res.json());
}

export async function refresh(refreshToken: string): Promise<StoredTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    clearTokens();
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const json = await res.json();
  // Spotify doesn't always return a new refresh token; keep the old one if absent.
  return store({ refresh_token: refreshToken, ...json });
}

function store(json: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}): StoredTokens {
  const tokens: StoredTokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  return tokens;
}

export function getStoredTokens(): StoredTokens | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export function clearTokens(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Returns a valid access token, refreshing if it expires within 60s.
 * Pass this as a function to the Web Playback SDK's `getOAuthToken` callback — the SDK
 * calls it again whenever the token expires mid-session.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = getStoredTokens();
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
  try {
    return (await refresh(tokens.refreshToken)).accessToken;
  } catch {
    return null;
  }
}
