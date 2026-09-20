/**
 * The signed-in half of the YouTube Data API: your playlists, your liked music.
 *
 * WHAT ACTUALLY COMES BACK, AND WHY
 * ---------------------------------
 * YouTube Music and YouTube share an account but not a data model, and the Data API
 * only knows about the YouTube side. In practice:
 *
 *   Your YTM playlists   — a playlist you created in YouTube Music IS an ordinary
 *                          YouTube playlist, so `playlists.list(mine=true)` returns it.
 *                          This is the big win from signing in.
 *
 *   Your Liked Music     — YouTube Music keeps this as the auto-playlist `LM`, which
 *                          the Data API does not officially support. But liking a song
 *                          in YT Music also likes the underlying YouTube video, so
 *                          `videos.list(myRating=like)` usually surfaces the same
 *                          tracks. We try `LM` first and fall back to `myRating=like`.
 *                          Whichever path works, we say which one we used rather than
 *                          quietly presenting a different list than you asked for.
 *
 *   Your YTM uploads     — not exposed by any official API. Not reachable.
 *
 * QUOTA
 * -----
 * 10,000 units/day. These calls are cheap — `list` operations cost 1 unit each, unlike
 * `search` at 100. You can page through a large library all day without trouble.
 */

import { getYouTubeAccessToken } from "./google-auth.ts";
import { parseIsoDuration, type YouTubeVideo } from "./youtube.ts";

const API_BASE = "https://www.googleapis.com/youtube/v3";

export interface Playlist {
  id: string;
  title: string;
  itemCount: number;
  thumbnail?: string;
}

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in to YouTube.");
  }
}

async function authed<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = await getYouTubeAccessToken();
  if (!token) throw new NotSignedInError();

  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 401) throw new NotSignedInError();
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

interface PlaylistsResponse {
  items: {
    id: string;
    snippet: { title: string; thumbnails?: { medium?: { url: string } } };
    contentDetails: { itemCount: number };
  }[];
  nextPageToken?: string;
}

/** Your playlists, including the ones you made in YouTube Music. */
export async function myPlaylists(): Promise<Playlist[]> {
  const out: Playlist[] = [];
  let pageToken: string | undefined;

  // Page through; a music library can easily exceed one page of 50.
  do {
    const data: PlaylistsResponse = await authed("playlists", {
      part: "snippet,contentDetails",
      mine: "true",
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });

    for (const item of data.items) {
      out.push({
        id: item.id,
        title: item.snippet.title,
        itemCount: item.contentDetails.itemCount,
        thumbnail: item.snippet.thumbnails?.medium?.url,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < 200);

  return out;
}

interface PlaylistItemsResponse {
  items: {
    snippet: {
      title: string;
      videoOwnerChannelTitle?: string;
      channelTitle?: string;
      resourceId: { videoId: string };
      thumbnails?: { medium?: { url: string } };
    };
  }[];
  nextPageToken?: string;
}

export async function playlistTracks(
  playlistId: string,
  max = 200,
): Promise<YouTubeVideo[]> {
  const out: YouTubeVideo[] = [];
  let pageToken: string | undefined;

  do {
    const data: PlaylistItemsResponse = await authed("playlistItems", {
      part: "snippet",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });

    for (const item of data.items) {
      const id = item.snippet.resourceId?.videoId;
      if (!id) continue;
      // Deleted and private videos stay in the playlist as tombstones. Showing them
      // just produces a dead link and an error page.
      if (
        item.snippet.title === "Deleted video" ||
        item.snippet.title === "Private video"
      ) {
        continue;
      }
      out.push({
        id,
        title: item.snippet.title,
        channel: (
          item.snippet.videoOwnerChannelTitle ??
          item.snippet.channelTitle ??
          ""
        ).replace(/\s*-\s*Topic$/i, ""),
        thumbnail: item.snippet.thumbnails?.medium?.url,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < max);

  return out;
}

interface VideosResponse {
  items: {
    id: string;
    snippet: { title: string; channelTitle: string; thumbnails?: { medium?: { url: string } } };
    contentDetails?: { duration: string };
  }[];
  nextPageToken?: string;
}

/**
 * Liked music.
 *
 * Tries the YouTube Music `LM` auto-playlist first; it is undocumented and usually
 * 404s, but when it works it is exactly the list you see in the app. Falls back to
 * liked videos, which for YT Music users largely overlaps.
 *
 * Returns which source succeeded so the UI can say so — presenting liked *videos* as
 * "Liked Music" without comment would be quietly wrong.
 */
export async function likedMusic(
  max = 200,
): Promise<{ tracks: YouTubeVideo[]; source: "LM" | "likedVideos" }> {
  try {
    const tracks = await playlistTracks("LM", max);
    if (tracks.length > 0) return { tracks, source: "LM" };
  } catch {
    // Expected for most accounts.
  }

  const out: YouTubeVideo[] = [];
  let pageToken: string | undefined;

  do {
    const data: VideosResponse = await authed("videos", {
      part: "snippet,contentDetails",
      myRating: "like",
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });

    for (const item of data.items) {
      out.push({
        id: item.id,
        title: item.snippet.title,
        channel: item.snippet.channelTitle.replace(/\s*-\s*Topic$/i, ""),
        thumbnail: item.snippet.thumbnails?.medium?.url,
        durationSec: item.contentDetails
          ? parseIsoDuration(item.contentDetails.duration)
          : undefined,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < max);

  return { tracks: out, source: "likedVideos" };
}
