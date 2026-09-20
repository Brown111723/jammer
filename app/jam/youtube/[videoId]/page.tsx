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
import { Transport } from "../../../../components/Transport";
import { useYouTubePlayer } from "../../../../hooks/useYouTubePlayer";
import { chartForRecording } from "../../../../lib/chart-store";
import { fetchLyrics } from "../../../../lib/lyrics";
import { SyncEngine } from "../../../../lib/sync-engine";
import { getVideos, guessArtistTitle, searchAvailable } from "../../../../lib/youtube";
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
  const [score, setScore] = useState<ArrayBuffer | string | null>(null);
  const [scoreTracks, setScoreTracks] = useState<{ index: number; name: string }[]>([]);
  const [scoreTrackIndex, setScoreTrackIndex] = useState(0);
  const [calibrating, setCalibrating] = useState(false);
  const attachedRef = useRef(false);

  const recording: RecordingRef = useMemo(
    () => ({ transport: "youtube", id: videoId, title: meta?.title }),
    [videoId, meta],
  );

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

  // Metadata, if an API key is configured. Costs 1 quota unit, versus 100 for a search.
  useEffect(() => {
    if (!searchAvailable()) return;
    void getVideos([videoId])
      .then(async (videos) => {
        const v = videos[0];
        if (!v) return;
        setMeta({ title: v.title, channel: v.channel });

        const { artist, title } = guessArtistTitle(v.title, v.channel);
        try {
          setLyrics(
            await fetchLyrics(
              title,
              artist,
              undefined,
              v.durationSec ? v.durationSec * 1000 : undefined,
            ),
          );
        } catch {
          setLyrics(null);
        }
      })
      .catch(() => {
        /* metadata is a nicety; the player works without it */
      });
  }, [videoId]);

  useEffect(() => {
    void chartForRecording({ transport: "youtube", id: videoId }).then((found) => {
      if (found) setChart(found);
    });
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
        <div className="file-inputs">
          <label>
            Score
            <input
              type="file"
              accept=".gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.xml"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setScore(await f.arrayBuffer());
              }}
            />
          </label>
          {scoreTracks.length > 1 && (
            <label>
              Staff
              <select
                value={scoreTrackIndex}
                onChange={(e) => setScoreTrackIndex(Number(e.target.value))}
              >
                {scoreTracks.map((t) => (
                  <option key={t.index} value={t.index}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
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
            scoreTrackIndex={scoreTrackIndex}
            onScoreTracksLoaded={setScoreTracks}
          />
        </div>
      </div>
    </main>
  );
}
