"use client";

/**
 * Local-file jam page — the development entry point and the full feature set.
 *
 * No auth, no Premium, no cloud. It's also the only mode where audio analysis is
 * possible at all: the file is the user's own, so it can be sent to the analyzer.
 * Spotify and YouTube audio never leaves the DRM pipeline.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JamWorkspace } from "../../../components/JamWorkspace";
import { LatencyCalibrator } from "../../../components/LatencyCalibrator";
import { Transport } from "../../../components/Transport";
import {
  analyzerAvailable,
  chartFromAnalysis,
  pollJob,
  stageLabel,
  submitAnalysis,
  type JobState,
} from "../../../lib/analyzer-client";
import { chartForRecording, saveChart } from "../../../lib/chart-store";
import { fetchLyrics } from "../../../lib/lyrics";
import { bufferToWav, pitchShiftBuffer } from "../../../lib/pitch-shift";
import { SyncEngine } from "../../../lib/sync-engine";
import { LocalTransport } from "../../../lib/transports/local-transport";
import type { JammerChart, Lyrics, RecordingRef } from "../../../lib/types";

const LATENCY_KEY = "jammer.outputLatencyMs";

export default function LocalJamPage() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const engine = useMemo(() => new SyncEngine(), []);

  const [file, setFile] = useState<File | null>(null);
  const [recording, setRecording] = useState<RecordingRef>({
    transport: "local",
    id: "none",
  });
  const [score, setScore] = useState<ArrayBuffer | string | null>(null);
  const [scoreTracks, setScoreTracks] = useState<{ index: number; name: string }[]>([]);
  const [scoreTrackIndex, setScoreTrackIndex] = useState(0);
  const [chart, setChart] = useState<JammerChart | null>(null);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [ready, setReady] = useState(false);

  const [audioSemitones, setAudioSemitones] = useState(0);
  const [shiftProgress, setShiftProgress] = useState<number | null>(null);
  const decodedRef = useRef<AudioBuffer | null>(null);
  // Rendered variants, keyed by semitone, so flipping back and forth is instant.
  const shiftCacheRef = useRef<Map<number, string>>(new Map());
  const originalUrlRef = useRef<string | null>(null);

  const [analyzerUp, setAnalyzerUp] = useState<boolean | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    const saved = Number(localStorage.getItem(LATENCY_KEY) ?? "0");
    if (Number.isFinite(saved)) engine.clock.outputLatencyMs = saved;
  }, [engine]);

  useEffect(() => {
    void analyzerAvailable().then(setAnalyzerUp);
  }, []);

  useEffect(() => {
    if (!audioRef.current) return;
    const transport = new LocalTransport(audioRef.current);
    engine.attachTransport(transport);
    setReady(true);
    return () => {
      engine.destroy();
      transport.destroy();
    };
  }, [engine]);

  const onAudioFile = useCallback(async (picked: File) => {
    if (!audioRef.current) return;

    // Drop any previously rendered variants — they belong to the old file.
    for (const url of shiftCacheRef.current.values()) URL.revokeObjectURL(url);
    shiftCacheRef.current.clear();
    decodedRef.current = null;
    setAudioSemitones(0);

    const url = URL.createObjectURL(picked);
    originalUrlRef.current = url;
    audioRef.current.src = url;
    setFile(picked);

    // Identity for a local file: name + size is stable enough to re-find its chart,
    // and far cheaper than hashing a 60MB file on the main thread.
    const ref: RecordingRef = {
      transport: "local",
      id: `${picked.name}:${picked.size}`,
      title: picked.name,
    };
    setRecording(ref);

    const existing = await chartForRecording(ref);
    if (existing) setChart(existing);

    // "Artist - Title.mp3" is the usual convention; a wrong guess costs nothing.
    const stem = picked.name.replace(/\.[^.]+$/, "");
    const [maybeArtist, maybeTitle] = stem.split(/\s+-\s+/);
    if (maybeArtist && maybeTitle) {
      try {
        setLyrics(await fetchLyrics(maybeTitle, maybeArtist));
      } catch {
        setLyrics(null);
      }
    }
  }, []);

  const runAnalysis = useCallback(async () => {
    if (!file) return;
    setAnalysisError(null);
    try {
      const jobId = await submitAnalysis(file);
      const result = await pollJob(jobId, setJob);

      const stem = file.name.replace(/\.[^.]+$/, "");
      const [maybeArtist, maybeTitle] = stem.split(/\s+-\s+/);

      const built = chartFromAnalysis(result, {
        title: maybeTitle ?? stem,
        artist: maybeArtist ?? "Unknown",
        recordingId: recording.id,
      });

      await saveChart(built);
      setChart(built);
      setJob(null);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : String(err));
      setJob(null);
    }
  }, [file, recording]);

  /**
   * Render the file at a different pitch and swap it into the <audio> element.
   *
   * Only possible because this is a local file: we own the samples. On Spotify or
   * YouTube the audio never leaves the DRM pipeline, which is why the control is
   * disabled there rather than merely slow.
   */
  const shiftAudio = useCallback(
    async (semitones: number) => {
      const audio = audioRef.current;
      if (!audio || !file) return;

      const resume = audio.currentTime;
      const wasPlaying = !audio.paused;

      const swap = (src: string) => {
        audio.src = src;
        // Restoring position matters: re-rendering mid-practice and being thrown back
        // to bar 1 would make the feature unusable.
        audio.currentTime = resume;
        if (wasPlaying) void audio.play();
        engine.clock.seek(resume * 1000);
        setAudioSemitones(semitones);
      };

      if (semitones === 0) {
        if (originalUrlRef.current) swap(originalUrlRef.current);
        return;
      }

      const cached = shiftCacheRef.current.get(semitones);
      if (cached) {
        swap(cached);
        return;
      }

      setShiftProgress(0);
      try {
        if (!decodedRef.current) {
          const ctx = new AudioContext();
          decodedRef.current = await ctx.decodeAudioData(await file.arrayBuffer());
          void ctx.close();
        }

        const offline = new OfflineAudioContext(
          decodedRef.current.numberOfChannels,
          decodedRef.current.length,
          decodedRef.current.sampleRate,
        );

        const shifted = await pitchShiftBuffer(
          offline,
          decodedRef.current,
          semitones,
          setShiftProgress,
        );

        const url = URL.createObjectURL(bufferToWav(shifted));
        shiftCacheRef.current.set(semitones, url);
        swap(url);
      } catch (err) {
        console.error("[jammer] pitch shift failed", err);
      } finally {
        setShiftProgress(null);
      }
    },
    [file, engine],
  );

  const commitLatency = useCallback(
    (ms: number) => {
      engine.clock.outputLatencyMs = ms;
      localStorage.setItem(LATENCY_KEY, String(ms));
      setCalibrating(false);
    },
    [engine],
  );

  const key = chart?.keys[0];
  const ts = chart?.timeSignatures[0]?.timeSignature;

  return (
    <main className="jam">
      <audio ref={audioRef} preload="auto" />

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
        <Link href="/">← Jammer</Link>
        <div className="file-inputs">
          <label>
            Audio
            <input
              type="file"
              accept="audio/*"
              onChange={(e) =>
                e.target.files?.[0] && void onAudioFile(e.target.files[0])
              }
            />
          </label>
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

        {file && analyzerUp && !job && (
          <button onClick={() => void runAnalysis()}>
            {chart ? "Re-analyse" : "Transcribe this file"}
          </button>
        )}
        {job && <span className="muted">{stageLabel(job)}</span>}
      </header>

      {analyzerUp === false && file && (
        <p className="workspace-notice">
          The analyzer isn&rsquo;t running, so transcription is unavailable. Start it
          with <code>uvicorn main:app --port 8000</code> in <code>analyzer/</code>, or
          load a Guitar Pro file instead.
        </p>
      )}
      {analysisError && <p className="warn jam-error">{analysisError}</p>}

      {ready && (
        <Transport
          engine={engine}
          title={chart?.title ?? file?.name}
          artist={chart?.artist}
          bpm={chart?.tempos[0]?.bpm}
          timeSignature={ts}
          musicalKey={key}
          confidence={chart?.confidence}
          canChangeRate
          onRateChange={(r) => {
            if (audioRef.current) audioRef.current.playbackRate = r;
          }}
          onCalibrate={() => setCalibrating(true)}
        />
      )}

      {ready && (file || score) ? (
        <JamWorkspace
          engine={engine}
          chart={chart}
          recording={recording}
          lyrics={lyrics}
          score={score}
          scoreTrackIndex={scoreTrackIndex}
          onScoreTracksLoaded={setScoreTracks}
          songTitle={chart?.title ?? file?.name}
          songArtist={chart?.artist}
          onChartImported={setChart}
          canShiftAudio
          audioSemitones={audioSemitones}
          onAudioShift={(n) => void shiftAudio(n)}
          shiftProgress={shiftProgress}
        />
      ) : (
        <Placeholder analyzerUp={analyzerUp} />
      )}
    </main>
  );
}

function Placeholder({ analyzerUp }: { analyzerUp: boolean | null }) {
  return (
    <div className="placeholder">
      <h2>Load an audio file to start</h2>
      <p>
        Everything stays on your machine. The audio drives the clock; the chart is what
        the playhead runs across.
      </p>
      <p className="muted">
        {analyzerUp
          ? "The analyzer is running, so you can transcribe a file straight to a chart."
          : "Without the analyzer running you can still load a Guitar Pro file."}
      </p>
      <p className="muted">
        Calibrate your latency (the ⏱ button) before judging how the sync feels.
        Bluetooth headphones will otherwise put the cursor a third of a second ahead of
        the sound.
      </p>
    </div>
  );
}
