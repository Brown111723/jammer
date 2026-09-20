import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVideoId,
  parsePlaylistId,
  parseStartSeconds,
  parseIsoDuration,
  guessArtistTitle,
} from "../lib/youtube.ts";
import { youtubeErrorMessage } from "../lib/transports/youtube-transport.ts";

test("parses video IDs out of every link shape a user might paste", () => {
  const id = "dQw4w9WgXcQ";

  // The one that matters most: YouTube Music's share link.
  assert.equal(parseVideoId(`https://music.youtube.com/watch?v=${id}`), id);
  assert.equal(
    parseVideoId(`https://music.youtube.com/watch?v=${id}&si=abc123XYZ`),
    id,
    "the share sheet's si= tracking param must not break it",
  );
  assert.equal(
    parseVideoId(`https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`),
    id,
    "radio/autoplay links carry a list= too",
  );

  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(parseVideoId(`https://youtube.com/watch?v=${id}`), id);
  assert.equal(parseVideoId(`https://m.youtube.com/watch?v=${id}`), id);
  assert.equal(parseVideoId(`https://youtu.be/${id}`), id);
  assert.equal(parseVideoId(`https://youtu.be/${id}?t=42`), id);
  assert.equal(parseVideoId(`https://www.youtube.com/embed/${id}`), id);
  assert.equal(parseVideoId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(parseVideoId(`https://www.youtube.com/live/${id}`), id);
  assert.equal(parseVideoId(`youtube.com/watch?v=${id}`), id, "no scheme");
  assert.equal(parseVideoId(id), id, "a bare ID");
  assert.equal(parseVideoId(`  ${id}  `), id, "whitespace");
});

test("rejects things that are not video links", () => {
  assert.equal(parseVideoId(""), null);
  assert.equal(parseVideoId("not a url"), null);
  assert.equal(parseVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(parseVideoId("https://youtube.com/watch?v=tooshort"), null);
  assert.equal(
    parseVideoId("https://youtube.com/watch?v=waaaaaaytoolongforanid"),
    null,
  );
  assert.equal(
    parseVideoId("https://music.youtube.com/playlist?list=PLabc"),
    null,
    "a playlist link has no video",
  );
});

test("extracts playlist IDs", () => {
  assert.equal(
    parsePlaylistId("https://music.youtube.com/playlist?list=PLabc123"),
    "PLabc123",
  );
  assert.equal(parsePlaylistId("https://youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(parsePlaylistId("nonsense"), null);
});

test("extracts start offsets in every format YouTube uses", () => {
  const base = "https://youtu.be/dQw4w9WgXcQ";
  assert.equal(parseStartSeconds(`${base}?t=90`), 90, "bare seconds");
  assert.equal(parseStartSeconds(`${base}?t=90s`), 90, "seconds suffix");
  assert.equal(parseStartSeconds(`${base}?t=1m30s`), 90, "compound");
  assert.equal(parseStartSeconds(`${base}?t=1h2m3s`), 3723, "with hours");
  assert.equal(parseStartSeconds(`${base}?start=45`), 45, "start= variant");
  assert.equal(parseStartSeconds(base), 0, "no offset");
  assert.equal(parseStartSeconds("nonsense"), 0);
});

test("parses ISO 8601 durations from the Data API", () => {
  assert.equal(parseIsoDuration("PT4M13S"), 253);
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("PT3M"), 180);
  assert.equal(parseIsoDuration("garbage"), 0);
});

test("guesses artist and title from YouTube video titles", () => {
  // The dominant convention.
  assert.deepEqual(guessArtistTitle("Radiohead - Creep", "Radiohead"), {
    artist: "Radiohead",
    title: "Creep",
  });

  // Music-video noise must be stripped or LRCLIB won't match.
  assert.deepEqual(
    guessArtistTitle("Nirvana - Come As You Are (Official Music Video)", "Nirvana"),
    { artist: "Nirvana", title: "Come As You Are" },
  );
  assert.deepEqual(
    guessArtistTitle("Led Zeppelin - Black Dog (Remaster 2007)", "Led Zeppelin"),
    { artist: "Led Zeppelin", title: "Black Dog" },
  );

  // YouTube Music serves "Artist - Topic" channels with a bare song title.
  assert.deepEqual(guessArtistTitle("Black Dog", "Led Zeppelin - Topic"), {
    artist: "Led Zeppelin",
    title: "Black Dog",
  });

  // Em dash and en dash separators both occur in the wild.
  assert.deepEqual(guessArtistTitle("Pixies – Where Is My Mind?", "Pixies"), {
    artist: "Pixies",
    title: "Where Is My Mind?",
  });
});

test("YouTube error codes become advice, not numbers", () => {
  // The one users will actually hit: labels block embedding on official videos.
  const blocked = youtubeErrorMessage(101);
  assert.match(blocked.message, /embedding/i);
  assert.match(blocked.hint ?? "", /Topic/, "should point at Topic uploads");
  assert.deepEqual(youtubeErrorMessage(150), blocked, "150 is the same condition");

  assert.match(youtubeErrorMessage(100).message, /doesn't exist|private/i);
  assert.match(youtubeErrorMessage(2).message, /valid/i);
  assert.match(youtubeErrorMessage(999).message, /999/, "unknown codes still surface");
});

test("chart matching normalises the noise that differs between sources", async () => {
  const { normaliseForMatch } = await import("../lib/chart-store.ts");

  // The same song, as it appears on YouTube vs. in an album tag.
  assert.equal(
    normaliseForMatch("Black Dog (Remaster 2007)"),
    normaliseForMatch("Black Dog"),
  );
  assert.equal(
    normaliseForMatch("Come As You Are (Official Music Video)"),
    normaliseForMatch("Come as you are"),
  );
  assert.equal(
    normaliseForMatch("Led Zeppelin - Topic"),
    normaliseForMatch("Led Zeppelin"),
  );
  // Punctuation and spacing vary constantly.
  assert.equal(
    normaliseForMatch("Don't Stop Me Now"),
    normaliseForMatch("Dont Stop Me Now"),
  );
  assert.equal(
    normaliseForMatch("Say It Ain't So"),
    normaliseForMatch("say it aint so"),
  );

  // But genuinely different songs must not collide.
  assert.notEqual(normaliseForMatch("Black Dog"), normaliseForMatch("Black Hole Sun"));
  assert.notEqual(normaliseForMatch("One"), normaliseForMatch("One Step Closer"));
});
