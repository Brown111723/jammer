/**
 * Thin Spotify Web API client — only the endpoints that still exist.
 *
 * DELIBERATELY ABSENT: `/audio-features`, `/audio-analysis`, `/recommendations`,
 * `/artists/{id}/related-artists`. All four were deprecated on 2024-11-27 and return a
 * bare 403 for any app created after that date. They were the free source of BPM, key
 * and time signature.
 *
 * If you find yourself reaching for them: that data now comes from `analyzer/`, and the
 * beat grid it produces is strictly better than the single averaged number Spotify used
 * to hand out.
 */

import { getValidAccessToken } from "./spotify-auth.ts";

const BASE = "https://api.spotify.com/v1";

export class SpotifyApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getValidAccessToken();
  if (!token) throw new SpotifyApiError(401, "Not authenticated");

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
    throw new SpotifyApiError(429, `Rate limited, retry after ${retryAfter}s`);
  }

  if (res.status === 403) {
    throw new SpotifyApiError(
      403,
      "Spotify returned 403. If this was /audio-features or /audio-analysis, those " +
        "endpoints are deprecated for apps created after 2024-11-27 and are not " +
        "coming back — use the analyzer instead.",
    );
  }

  if (!res.ok) {
    throw new SpotifyApiError(res.status, `${res.status}: ${await res.text()}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------- shapes

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  images: SpotifyImage[];
  artists: SpotifyArtist[];
  release_date?: string;
  total_tracks?: number;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  explicit?: boolean;
}

export interface SpotifyProfile {
  id: string;
  display_name: string | null;
  email?: string;
  /** "premium" | "free" | "open" — the Web Playback SDK needs "premium". */
  product?: string;
  images?: SpotifyImage[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
}

// ---------------------------------------------------------------- endpoints

export const spotify = {
  me: () => call<SpotifyProfile>("/me"),

  search: (query: string, types: string[] = ["track"], limit = 20) =>
    call<{ tracks?: Paged<SpotifyTrack>; albums?: Paged<SpotifyAlbum> }>(
      `/search?q=${encodeURIComponent(query)}&type=${types.join(",")}&limit=${limit}`,
    ),

  savedTracks: (limit = 50, offset = 0) =>
    call<Paged<{ added_at: string; track: SpotifyTrack }>>(
      `/me/tracks?limit=${limit}&offset=${offset}`,
    ),

  savedAlbums: (limit = 50, offset = 0) =>
    call<Paged<{ added_at: string; album: SpotifyAlbum }>>(
      `/me/albums?limit=${limit}&offset=${offset}`,
    ),

  playlists: (limit = 50, offset = 0) =>
    call<Paged<{ id: string; name: string; images: SpotifyImage[]; tracks: { total: number } }>>(
      `/me/playlists?limit=${limit}&offset=${offset}`,
    ),

  playlistTracks: (id: string, limit = 100, offset = 0) =>
    call<Paged<{ track: SpotifyTrack }>>(
      `/playlists/${id}/tracks?limit=${limit}&offset=${offset}`,
    ),

  albumTracks: (id: string) =>
    call<Paged<SpotifyTrack>>(`/albums/${id}/tracks?limit=50`),

  track: (id: string) => call<SpotifyTrack>(`/tracks/${id}`),

  topTracks: (limit = 50) =>
    call<Paged<SpotifyTrack>>(`/me/top/tracks?limit=${limit}`),

  /** Start playback of a URI on a specific device (our Web Playback SDK player). */
  playOnDevice: (deviceId: string, uris: string[], positionMs = 0) =>
    call<void>(`/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
      body: JSON.stringify({ uris, position_ms: positionMs }),
    }),

  transferPlayback: (deviceId: string, play = false) =>
    call<void>("/me/player", {
      method: "PUT",
      body: JSON.stringify({ device_ids: [deviceId], play }),
    }),
};

export function artistNames(t: { artists: SpotifyArtist[] }): string {
  return t.artists.map((a) => a.name).join(", ");
}

export function albumArt(album: SpotifyAlbum, minSize = 200): string | undefined {
  const sorted = [...(album.images ?? [])].sort(
    (a, b) => (a.width ?? 0) - (b.width ?? 0),
  );
  return (sorted.find((i) => (i.width ?? 0) >= minSize) ?? sorted.at(-1))?.url;
}
