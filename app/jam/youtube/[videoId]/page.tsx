"use client";

/**
 * YouTube jam page.
 *
 * The third transport, and the most capable one for practice: YouTube supports
 * `setPlaybackRate`, so you can work a solo at 70% speed. Spotify cannot do that at all.
 *
 * The player is visible by design, not by accident. YouTube's terms require an
 * embedded player of at least 200×200, and for a guitar app a visible video is a
 * feature anyway — plenty of the useful uploads are people playing the part.
 */

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JamWorkspace } from "../../../../components/JamWorkspace";
import { LatencyCalibrator } from "../../../../components/LatencyCalibrator";
import { ScorePicker } from "../../../../components/ScorePicker";
import { Transport } from "../../../../components/Transport";
import { useYouTubePlayer } from "../../../../hooks/useYouTubePlayer";
import { useScoreFile } from "../../../../hooks/useScoreFile";
import { findChartForSong } from "../../../../lib/chart-store";
import { fetchLyrics } from "../../../../lib/lyrics";
import { SyncEngine } from "../../../../lib/sync-engine";
import {
  fetchOEmbedMeta,
  getVideos,
  guessArtistTitle,
  searchAvailable,
} from "../../../../lib/youtube";
import type { JammerChart, Lyrics, RecordingRef } from "../../../../lib/types";

const LATENCY_KEY = "jammer.outputLatencyMs";

export default function YouTubeJamPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = use(params);
  const engine = useMemo(() => new SyncEngine(), []);

  const [startSeconds] = useState(() => {
    if (typeof window === "undefined") return 0;
    return Number(new URLSearchParams(window.location.search).get("t") ?? 0) || 0;
  });

  const { hostRef, status, transport, rates } = useYouTubePlayer(videoId, startSeconds);

  const [meta, setMeta] = useState<{ title: string; channel: string } | null>(null);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [chart, setChart] = useState<JammerChart | null>(null);
  /** Artist and title as best they can be read from the video. */
  const [song, setSong] = useState<{ title: string; artist: string } | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  /** Whether the chart was aligned to this exact video, or matched from another one. */
  const [chartMatch, setChartMatch] = useState<"exact" | "matched" | null>(null);
  const attachedRef = useRef(false);

  const recording: RecordingRef = useMemo(
    () => ({ transport: "youtube", id: videoId, title: meta?.title }),
    [videoId, meta],
  );

  const scoreFile = useScoreFile({
    recording,
    title: song?.title,
    artist: song?.artist,
    chart,
    setChart,
  });
  const { score } = scoreFile;

  useEffect(() => {
    const saved = Number(localStorage.getItem(LATENCY_KEY) ?? "0");
    if (Number.isFinite(saved)) engine.clock.outputLatencyMs = saved;
    return () => engine.destroy();
  }, [engine]);

  useEffect(() => {
    if (!transport || attachedRef.current) return;
    attachedRef.current = true;
    engine.attachTransport(transport);
  }, [transport, engine]);

  /**
   * Everything that can be automatic, is.
   *
   * On load: get the title via oEmbed (no key, no quota), then look up synced lyrics
   * on LRCLIB and search for a chart that already covers this song. Nothing here asks
   * the user for anything.
   *
   * The Data API is used only as an upgrade when a key exists — it adds the duration,
   * which makes the LRCLIB match more precise.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // oEmbed first: it always works.
      let title: string | undefined;
      let channel: string | undefined;
      let durationMs: number | undefined;

      const basic = await fetchOEmbedMeta(videoId);
      if (basic) {
        title = basic.title;
        channel = basic.channel;
        if (!cancelled) setMeta({ title: basic.title, channel: basic.channel });
      }

      // Upgrade with the Data API if a key is configured — mainly for the duration.
      if (searchAvailable()) {
        try {
          const v = (await getVideos([videoId]))[0];
          if (v) {
            title = v.title;
            channel = v.channel;
            durationMs = v.durationSec ? v.durationSec * 1000 : undefined;
            if (!cancelled) setMeta({ title: v.title, channel: v.channel });
          }
        } catch {
          /* the oEmbed data is enough */
        }
      }

      if (!title || cancelled) return;

      const guessed = guessArtistTitle(title, channel ?? "");
      if (!cancelled) setSong(guessed);

      // Lyrics — fully automatic, every time, for any song LRCLIB knows.
      try {
        const found = await fetchLyrics(
          guessed.title,
          guessed.artist,
          undefined,
          durationMs,
        );
        if (!cancelled) setLyrics(found);
      } catch {
        if (!cancelled) setLyrics(null);
      }

      // A chart from ANY source counts: the format is recording-independent, so one
      // analysed locally applies here too. This is what makes analysing a song once
      // worth doing.
      const match = await findChartForSong(guessed.title, guessed.artist, {
        transport: "youtube",
        id: videoId,
      });
      if (match && !cancelled) {
        setChart(match.chart);
        setChartMatch(match.exact ? "exact" : "matched");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [videoId]);

  const commitLatency = useCallback(
    (ms: number) => {
      engine.clock.outputLatencyMs = ms;
      localStorage.setItem(LATENCY_KEY, String(ms));
      setCalibrating(false);
    },
    [engine],
  );

  const canSlowDown = rates.length > 1;

  return (
    <main className="jam">
      {calibrating && (
        <div className="modal">
          <LatencyCalibrator
            initialMs={engine.clock.outputLatencyMs}
            onCommit={commitLatency}
            onCancel={() => setCalibrating(false)}
          />
        </div>
      )}

      <header className="jam-header">
        <Link href="/youtube">← Search</Link>
        <ScorePicker
          scoreName={scoreFile.scoreName}
          scoreTracks={scoreFile.scoreTracks}
          scoreTrackIndex={scoreFile.scoreTrackIndex}
          onTrackIndex={scoreFile.setScoreTrackIndex}
          onFile={(f) => void scoreFile.openScoreFile(f)}
        />
      </header>

      {status.kind === "error" && (
        <div className="warn jam-error">
          <strong>{status.message}</strong>
          {status.hint && <p>{status.hint}</p>}
          <Link href="/youtube">Try another video →</Link>
        </div>
      )}

      <div className="yt-shell">
        {/* YouTube's terms require a visible player of at least 200x200. */}
        <div className="yt-player">
          <div ref={hostRef} className="yt-frame" />
          {status.kind === "loading" && (
            <p className="muted yt-loading">Loading player…</p>
          )}
        </div>

        <div className="yt-main">
          <Transport
            engine={engine}
            title={meta?.title ?? `YouTube ${videoId}`}
            artist={meta?.channel}
            bpm={chart?.tempos[0]?.bpm}
            timeSignature={chart?.timeSignatures[0]?.timeSignature}
            musicalKey={chart?.keys[0]}
            confidence={chart?.confidence}
            canChangeRate={canSlowDown}
            onRateChange={(r) => void transport?.setRate(r)}
            onCalibrate={() => setCalibrating(true)}
          />

          {scoreFile.scoreMessage && (
            <p className="workspace-notice ok" role="status">
              {scoreFile.scoreMessage}{" "}
              <button className="linkish" onClick={scoreFile.dismissScoreMessage}>
                OK
              </button>
            </p>
          )}

          {chart && chartMatch === "matched" && !chart.scoreFile && (
            <p className="workspace-notice">
              Using the chart you made for &ldquo;{chart.title}&rdquo; on another
              recording. If it runs early or late, use Align.
            </p>
          )}

          {!chart && !score && (
            <p className="workspace-notice">
              No chart for this video yet. Load a Guitar Pro file, or transcribe your
              own copy of the audio in <Link href="/jam/local">local mode</Link> and
              align it here — YouTube&rsquo;s stream is DRM-protected, so it can&rsquo;t
              be transcribed directly.
            </p>
          )}

          <JamWorkspace
            engine={engine}
            chart={chart}
            recording={recording}
            lyrics={lyrics}
            score={score}
            scoreTrackIndex={scoreFile.scoreTrackIndex}
            onScoreTracksLoaded={scoreFile.setScoreTracks}
            songTitle={song?.title}
            songArtist={song?.artist}
            onChartImported={(c) => {
              setChart(c);
              setChartMatch("exact");
            }}
          />
        </div>
      </div>
    </main>
  );
}
