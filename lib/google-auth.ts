/**
 * Google / YouTube OAuth, client half.
 *
 * The code exchange goes through `/api/youtube/token` because Google's Web application
 * clients require a secret (see that route for why). Everything else — the redirect,
 * PKCE generation, token storage, refresh scheduling — lives here.
 *
 * Scope is `youtube.readonly` and nothing more. Jammer reads your library; it never
 * writes to your account, and requesting a write scope you don't use is how consent
 * screens start looking alarming.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const STORAGE_KEY = "jammer.youtube.tokens";
const VERIFIER_KEY = "jammer.youtube.verifier";

export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

function base64Url(bytes: ArrayBuffer): string {
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

export function youtubeClientId(): string | null {
  return process.env.NEXT_PUBLIC_YOUTUBE_CLIENT_ID || null;
}

export function youtubeSignInAvailable(): boolean {
  return !!youtubeClientId();
}

export function youtubeRedirectUri(): string {
  return `${window.location.origin}/youtube/callback`;
}

export async function beginYouTubeLogin(): Promise<void> {
  const clientId = youtubeClientId();
  if (!clientId) {
    throw new Error(
      "NEXT_PUBLIC_YOUTUBE_CLIENT_ID is not set. See .env.example for setup.",
    );
  }

  const verifier = randomVerifier();
  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: youtubeRedirectUri(),
    response_type: "code",
    scope: YOUTUBE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Without access_type=offline Google issues no refresh token at all, and the
    // session dies after an hour.
    access_type: "offline",
    // And without prompt=consent it issues no refresh token on *repeat* logins,
    // because it assumes you kept the first one. That asymmetry is the single most
    // common Google OAuth bug.
    prompt: "consent",
    include_granted_scopes: "true",
  });

  window.location.href = `${AUTH_ENDPOINT}?${params}`;
}

export async function completeYouTubeLogin(code: string): Promise<GoogleTokens> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) {
    throw new Error(
      "No PKCE verifier found — the sign-in was started in a different tab, or " +
        "storage was cleared. Start it again.",
    );
  }

  const res = await fetch("/api/youtube/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier: verifier,
      redirectUri: youtubeRedirectUri(),
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `Sign-in failed (${res.status}).`);

  sessionStorage.removeItem(VERIFIER_KEY);
  return store(json);
}

function store(json: {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}): GoogleTokens {
  const tokens: GoogleTokens = {
    accessToken: json.accessToken,
    refreshToken: json.refreshToken,
    expiresAt: Date.now() + json.expiresIn * 1000,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  return tokens;
}

export function getStoredYouTubeTokens(): GoogleTokens | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GoogleTokens) : null;
  } catch {
    return null;
  }
}

export function clearYouTubeTokens(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function isYouTubeSignedIn(): boolean {
  return !!getStoredYouTubeTokens();
}

/** Valid access token, refreshing if it expires within 60s. */
export async function getYouTubeAccessToken(): Promise<string | null> {
  const tokens = getStoredYouTubeTokens();
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;

  if (!tokens.refreshToken) {
    clearYouTubeTokens();
    return null;
  }

  try {
    const res = await fetch("/api/youtube/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    return store(json).accessToken;
  } catch {
    clearYouTubeTokens();
    return null;
  }
}
