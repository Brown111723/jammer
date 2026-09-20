/**
 * YouTube / YouTube Music helpers.
 *
 * THE KEY FACT
 * ------------
 * A YouTube Music track and the corresponding YouTube video share the same 11-character
 * video ID. `music.youtube.com/watch?v=dQw4w9WgXcQ` and
 * `youtube.com/watch?v=dQw4w9WgXcQ` are the same thing to the IFrame player.
 *
 * That makes Share → Copy link in the YouTube Music app a complete, zero-auth,
 * zero-quota path into Jammer. It is the primary way in, and it is more reliable than
 * anything built on an API.
 *
 * WHAT IS AND ISN'T REACHABLE
 * ---------------------------
 * There is no official YouTube Music API. What exists:
 *
 *   ✅ IFrame Player API      — plays any embeddable video. Official, stable, free.
 *   ✅ Data API v3 search     — official. Needs an API key. 10,000 quota units/day,
 *                               and a search costs 100, so ~100 searches/day free.
 *   ✅ Data API v3 playlists  — your own YouTube playlists via OAuth. YouTube Music
 *                               playlists you created are backed by YouTube playlists,
 *                               so most of them show up here.
 *   ❌ "Liked Music"          — a YouTube Music auto-playlist (id `LM`). Not exposed by
 *                               the Data API at all.
 *   ❌ YT Music uploads       — not exposed.
 *
 * `ytmusicapi` reaches the rest by replaying web-client requests with your cookies.
 * Fine for a personal script; it breaks without warning and is not something to build
 * a product on. If you want your Liked Music here, the honest route is to copy it into
 * a normal playlist, which the Data API can then see.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * Pull an 11-character video ID out of anything a user is likely to paste.
 *
 * Handles: youtube.com/watch?v=, youtu.be/, music.youtube.com/watch?v=,
 * /embed/, /shorts/, /live/, and a bare ID. Also strips the `si=` tracking
 * parameter the share sheet appends, and `t=`/`start=` timestamps.
 */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A bare video ID.
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");
  const valid = (id: string | null | undefined) =>
    id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;

  if (host === "youtu.be") {
    return valid(url.pathname.slice(1).split("/")[0]);
  }

  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com"
  ) {
    const v = valid(url.searchParams.get("v"));
    if (v) return v;

    const match = /^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
    if (match) return valid(match[2]);
  }

  return null;
}

/** Playlist ID from a URL, if there is one. `LM` (Liked Music) is not usable. */
export function parsePlaylistId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const list = url.searchParams.get("list");
    return list && /^[A-Za-z0-9_-]+$/.test(list) ? list : null;
  } catch {
    return null;
  }
}

/** Start offset in seconds from a `t=` or `start=` parameter. */
export function parseStartSeconds(input: string): number {
  try {
    const url = new URL(input.trim());
    const raw = url.searchParams.get("t") ?? url.searchParams.get("start");
    if (!raw) return 0;

    // `t` can be "90", "90s", or "1m30s".
    const compound = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
    if (compound && (compound[1] || compound[2] || compound[3])) {
      return (
        Number(compound[1] ?? 0) * 3600 +
        Number(compound[2] ?? 0) * 60 +
        Number(compound[3] ?? 0)
      );
    }
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- oEmbed

/**
 * Title and channel for a video, with NO API key and NO quota.
 *
 * YouTube's oEmbed endpoint is public, CORS-enabled and unmetered. It returns exactly
 * the two fields we need to look up lyrics — `title` and `author_name`.
 *
 * This matters more than it looks: metadata used to be gated behind the Data API key,
 * so a user who just pasted a link got no lyrics at all. Lyrics are the one piece of
 * this app that can be fully automatic for any song, and requiring a Google Cloud
 * project to get them was indefensible.
 *
 * The Data API is still worth using when a key exists — it also gives the duration,
 * which sharpens the LRCLIB match — but it is no longer required.
 */
export async function fetchOEmbedMeta(
  videoId: string,
): Promise<{ title: string; channel: string; thumbnail?: string } | null> {
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;

  try {
    const res = await fetch(url);
    // 401/404 here means private, deleted, or embedding disabled.
    if (!res.ok) return null;

    const json = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    if (!json.title) return null;

    return {
      title: decodeEntities(json.title),
      channel: decodeEntities(json.author_name ?? ""),
      thumbnail: json.thumbnail_url,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Data API

export interface YouTubeVideo {
  id: string;
  title: string;
  channel: string;
  thumbnail?: string;
  /** Seconds. Only present from `videos.list`, not from `search.list`. */
  durationSec?: number;
}

export class YouTubeQuotaError extends Error {
  constructor() {
    super(
      "YouTube Data API quota exceeded for today. Search costs 100 of the 10,000 " +
        "daily units, so roughly 100 searches. Paste a link instead — that costs nothing.",
    );
  }
}

function apiKey(): string | null {
  return process.env.NEXT_PUBLIC_YOUTUBE_API_KEY || null;
}

export function searchAvailable(): boolean {
  return !!apiKey();
}

async function dataApi<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = apiKey();
  if (!key) {
    throw new Error(
      "No YouTube API key. Set NEXT_PUBLIC_YOUTUBE_API_KEY in .env.local to enable " +
        "search, or paste a video link instead.",
    );
  }

  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);

  const res = await fetch(url);
  if (res.status === 403) {
    const body = await res.text();
    if (body.includes("quotaExceeded")) throw new YouTubeQuotaError();
    throw new Error(`YouTube API refused the request: ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  return res.json() as Promise<T>;
}

interface SearchResponse {
  items: {
    id: { videoId: string };
    snippet: {
      title: string;
      channelTitle: string;
      thumbnails?: { medium?: { url: string }; default?: { url: string } };
    };
  }[];
}

/**
 * Search YouTube.
 *
 * `videoCategoryId=10` restricts to the Music category, which cuts out most of the
 * reaction videos, lyric-video reuploads and tutorials that otherwise crowd out the
 * actual track. `videoEmbeddable=true` is essential: a video that can't be embedded
 * will load and then immediately error with code 101/150, which looks like a bug.
 */
export async function searchVideos(query: string, limit = 20): Promise<YouTubeVideo[]> {
  const data = await dataApi<SearchResponse>("search", {
    part: "snippet",
    q: query,
    type: "video",
    videoCategoryId: "10",
    videoEmbeddable: "true",
    maxResults: String(Math.min(limit, 50)),
  });

  return data.items.map((item) => ({
    id: item.id.videoId,
    title: decodeEntities(item.snippet.title),
    channel: decodeEntities(item.snippet.channelTitle),
    thumbnail:
      item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url,
  }));
}

interface VideosResponse {
  items: {
    id: string;
    snippet: {
      title: string;
      channelTitle: string;
      thumbnails?: { medium?: { url: string } };
    };
    contentDetails: { duration: string };
    status: { embeddable: boolean };
  }[];
}

/** Metadata for known IDs. Costs only 1 quota unit, versus 100 for a search. */
export async function getVideos(ids: string[]): Promise<YouTubeVideo[]> {
  if (ids.length === 0) return [];

  const data = await dataApi<VideosResponse>("videos", {
    part: "snippet,contentDetails,status",
    id: ids.slice(0, 50).join(","),
  });

  return data.items.map((item) => ({
    id: item.id,
    title: decodeEntities(item.snippet.title),
    channel: decodeEntities(item.snippet.channelTitle),
    thumbnail: item.snippet.thumbnails?.medium?.url,
    durationSec: parseIsoDuration(item.contentDetails.duration),
  }));
}

/** ISO 8601 duration ("PT4M13S") to seconds. */
export function parseIsoDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  return (
    Number(m[1] ?? 0) * 86400 +
    Number(m[2] ?? 0) * 3600 +
    Number(m[3] ?? 0) * 60 +
    Number(m[4] ?? 0)
  );
}

/** The Data API returns HTML entities in titles ("Don&#39;t Stop"). */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Split "Artist - Title (Official Video)" into artist and title, for the lyrics lookup.
 *
 * YouTube titles are not metadata and this will sometimes be wrong — but LRCLIB needs
 * an artist and a title, and a wrong guess costs one failed lookup. The alternative
 * (no lyrics at all on YouTube) is worse.
 */
export function guessArtistTitle(
  videoTitle: string,
  channel: string,
): { artist: string; title: string } {
  let cleaned = videoTitle
    // The usual noise in music-video titles.
    .replace(
      /\s*[([]\s*(official\s*)?(music\s*)?(lyric\s*)?(video|audio|visualizer|hd|4k|remaster(ed)?(\s*\d{4})?|explicit|clean|mv)\s*[)\]]/gi,
      "",
    )
    .replace(/\s*\|\s*official.*$/i, "")
    .trim();

  // "Artist - Title" is the dominant convention.
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(cleaned);
  if (dash) {
    return { artist: dash[1].trim(), title: dash[2].trim() };
  }

  // Otherwise the channel is usually the artist — true for "Artist - Topic" channels,
  // which is what YouTube Music serves.
  return {
    artist: channel.replace(/\s*-\s*Topic$/i, "").trim(),
    title: cleaned,
  };
}
