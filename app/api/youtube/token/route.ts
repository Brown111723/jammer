/**
 * Google OAuth token exchange — server side.
 *
 * WHY THIS ROUTE EXISTS, WHEN SPOTIFY NEEDED NO SUCH THING
 * --------------------------------------------------------
 * Spotify supports PKCE for genuine public clients: no client secret anywhere, the
 * whole flow runs in the browser (see `lib/spotify-auth.ts`).
 *
 * Google is different. Its "Web application" OAuth client type requires a client
 * secret at the token endpoint even when PKCE is in use. The only Google client type
 * that is a true public client is "Desktop app", which expects a loopback redirect and
 * is a poor fit for a hosted web app.
 *
 * So the exchange happens here, on the server, where `YOUTUBE_CLIENT_SECRET` can live
 * without shipping to the browser. Note the env var deliberately has no `NEXT_PUBLIC_`
 * prefix — that prefix is what inlines a value into the client bundle, and a secret
 * with that prefix would be published to every visitor.
 *
 * PKCE is still used on top of the secret. It costs nothing and it closes the
 * authorization-code interception window regardless of how the client is classified.
 */

import { NextResponse } from "next/server";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

interface TokenRequest {
  code?: string;
  codeVerifier?: string;
  refreshToken?: string;
  redirectUri?: string;
}

export async function POST(request: Request) {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      {
        error:
          "YouTube sign-in is not configured. Set YOUTUBE_CLIENT_ID and " +
          "YOUTUBE_CLIENT_SECRET in .env.local. Pasting links works without this.",
      },
      { status: 501 },
    );
  }

  let body: TokenRequest;
  try {
    body = (await request.json()) as TokenRequest;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });

  if (body.refreshToken) {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", body.refreshToken);
  } else if (body.code && body.codeVerifier && body.redirectUri) {
    params.set("grant_type", "authorization_code");
    params.set("code", body.code);
    params.set("code_verifier", body.codeVerifier);
    params.set("redirect_uri", body.redirectUri);
  } else {
    return NextResponse.json(
      { error: "Provide either refreshToken, or code + codeVerifier + redirectUri." },
      { status: 400 },
    );
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const json = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    // Google's errors are actually informative; pass them through rather than
    // flattening them into "sign-in failed".
    return NextResponse.json(
      {
        error:
          (json.error_description as string) ??
          (json.error as string) ??
          "Token exchange failed.",
      },
      { status: res.status },
    );
  }

  // Only what the client needs. Never echo the secret or the raw id_token.
  return NextResponse.json({
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? body.refreshToken ?? null,
    expiresIn: json.expires_in ?? 3600,
  });
}
