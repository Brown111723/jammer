"use client";

/**
 * Spotify jam page.
 *
 * Structurally identical to the local page below the transport bar — which is the
 * point. Swapping the transport is the only difference; the clock, the sync engine and
 * every component above them are unchanged.
 *
 * What it cannot do, and why: no transcription (the stream is DRM-protected) and no
 * playback-rate control (the Web Playback SDK has none). Both are surfaced in the UI
 * rather than failing quietly.
 */

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JamWorkspace } from "../../../../components/JamWorkspace";
import { LatencyCalibrator } from "../../../../components/LatencyCalibrator";
import { Transport } from "../../../../components/Transport";
import { chartForRecording } from "../../../../lib/chart-store";
import { fetchLyrics } from "../../../../lib/lyrics";
import { artistNames, spotify, type SpotifyTrack } from "../../../../lib/spotify-api";
import { SyncEngine } from "../../../../lib/sync-engine";
import { useSpotifyPlayer } from "../../../../hooks/useSpotifyPlayer";
import type { JammerChart, Lyrics, RecordingRef } from "../../../../lib/types";

const LATENCY_KEY = "jammer.outputLatencyMs";

export default function SpotifyJamPage({
  params,
}: {
  params: Promise<{ trackId: string }>;
}) {
  const { trackId } = use(params);

  const engine = useMemo(() => new SyncEngine(), []);
  const { status, transport, connect } = useSpotifyPlayer();

  const [track, setTrack] = useState<SpotifyTrack | null>(null);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [chart, setChart] = useState<JammerChart | null>(null);
  const [score, setScore] = useState<ArrayBuffer | string | null>(null);
  const [scoreTracks, setScoreTracks] = useState<{ index: number; name: string }[]>([]);
  const [scoreTrackIndex, setScoreTrackIndex] = useState(0);
  const [calibrating, setCalibrating] = useState(false);
  const startedRef = useRef(false);

  const recording: RecordingRef = useMemo(
    () => ({
      transport: "spotify",
      id: trackId,
      durationMs: track?.duration_ms,
      title: track?.name,
      artist: track ? artistNames(track) : undefined,
      album: track?.album.name,
    }),
    [trackId, track],
  );

  useEffect(() => {
    const saved = Number(localStorage.getItem(LATENCY_KEY) ?? "0");
    if (Number.isFinite(saved)) engine.clock.outputLatencyMs = saved;
    return () => engine.destroy();
  }, [engine]);

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    spotify
      .track(trackId)
      .then(async (t) => {
        setTrack(t);
        try {
          setLyrics(
            await fetchLyrics(
              t.name,
              t.artists[0]?.name ?? "",
              t.album.name,
              t.duration_ms,
            ),
          );
        } catch {
          setLyrics(null);
        }
      })
      .catch(() => setTrack(null));
  }, [trackId]);

  // A chart previously aligned to this recording, if there is one.
  useEffect(() => {
    void chartForRecording({ transport: "spotify", id: trackId }).then((found) => {
      if (found) setChart(found);
    });
  }, [trackId]);

  useEffect(() => {
    if (status.kind !== "ready" || !transport || !track || startedRef.current) return;
    startedRef.current = true;

    engine.attachTransport(transport);
    // Playback must be started through the Web API against our device id — the SDK
    // has no "play this URI" call of its own.
    void spotify.playOnDevice(status.deviceId, [track.uri]).catch(() => {
      /* transient; the user can press play */
    });
  }, [status, transport, track, engine]);

  const commitLatency = useCallback(
    (ms: number) => {
      engine.clock.outputLatencyMs = ms;
      localStorage.setItem(LATENCY_KEY, String(ms));
      setCalibrating(false);
    },
    [engine],
  );

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
        <Link href="/library">← Library</Link>
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
          <Link href="/jam/local">Use local-file mode instead →</Link>
        </div>
      )}

      {status.kind === "loading" && <p className="muted jam-error">Starting player…</p>}

      <Transport
        engine={engine}
        title={track?.name}
        artist={track ? artistNames(track) : undefined}
        bpm={chart?.tempos[0]?.bpm}
        timeSignature={chart?.timeSignatures[0]?.timeSignature}
        musicalKey={chart?.keys[0]}
        confidence={chart?.confidence}
        canChangeRate={false}
        onCalibrate={() => setCalibrating(true)}
      />

      {!chart && !score && (
        <p className="workspace-notice">
          No chart for this track yet. Load a Guitar Pro file, or transcribe your own
          copy of the audio in{" "}
          <Link href="/jam/local">local mode</Link> &mdash; the chart you make there can
          be aligned to this Spotify recording with the Align tool.
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
    </main>
  );
}
