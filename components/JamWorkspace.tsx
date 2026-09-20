"use client";

/**
 * The jam workspace — everything below the transport bar.
 *
 * Shared by the Spotify and local pages, because the only thing that differs between
 * them is which Transport is attached. If this component ever needs to know which one
 * it's running on, something has leaked that shouldn't have.
 *
 * VIEWS
 * -----
 * Highway and notation answer different questions and people want different ones:
 *   - Highway: "what do I play right now?" — for playing along at speed.
 *   - Notation: "how does this piece go?" — for reading, learning, seeing structure.
 * Split view is the default because the highway alone loses the shape of the song, and
 * notation alone is hard to follow at tempo.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChordPanel } from "./ChordPanel";
import { FretboardHighway } from "./FretboardHighway";
import { LyricsView } from "./LyricsView";
import { SyncEditor } from "./SyncEditor";
import { TabView } from "./TabView";
import { buildHighwayNotes } from "../lib/fretboard";
import { saveSyncPoints } from "../lib/chart-store";
import type { SyncEngine } from "../lib/sync-engine";
import {
  PPQ,
  TickMap,
  type JammerChart,
  type Lyrics,
  type RecordingRef,
  type SyncPoint,
} from "../lib/types";

export type JamView = "split" | "highway" | "notation";

export interface JamWorkspaceProps {
  engine: SyncEngine;
  chart: JammerChart | null;
  recording: RecordingRef;
  lyrics: Lyrics | null;
  /** A Guitar Pro / MusicXML file, when one was loaded directly. */
  score: ArrayBuffer | string | null;
  onScoreTracksLoaded?: (tracks: { index: number; name: string }[]) => void;
  scoreTrackIndex?: number;
}

export function JamWorkspace({
  engine,
  chart,
  recording,
  lyrics,
  score,
  onScoreTracksLoaded,
  scoreTrackIndex = 0,
}: JamWorkspaceProps) {
  const [view, setView] = useState<JamView>("split");
  const [trackId, setTrackId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [points, setPoints] = useState<SyncPoint[]>([]);
  const [lookAhead, setLookAhead] = useState(3000);
  const [showLyrics, setShowLyrics] = useState(true);

  // Adopt the chart's sync points when the chart changes.
  useEffect(() => {
    if (!chart) {
      setPoints([]);
      return;
    }
    const set = chart.syncSets.find(
      (s) => s.recording.transport === recording.transport && s.recording.id === recording.id,
    );
    setPoints(set?.points ?? chart.syncSets[0]?.points ?? []);
  }, [chart, recording]);

  // Default to the first playable track.
  useEffect(() => {
    if (!chart || trackId) return;
    const playable = chart.tracks.find((t) => (t.notes?.length ?? 0) > 0);
    setTrackId(playable?.id ?? chart.tracks[0]?.id ?? null);
  }, [chart, trackId]);

  const ticksPerBar = useMemo(() => {
    const ts = chart?.timeSignatures[0]?.timeSignature;
    if (!ts) return 4 * PPQ;
    return (ts.numerator * 4 * PPQ) / ts.denominator;
  }, [chart]);

  const tickMap = useMemo(
    () => new TickMap(points, chart?.tempos[0]?.bpm ?? 120, chart?.ppq ?? PPQ),
    [points, chart],
  );

  const activeTrack = useMemo(
    () => chart?.tracks.find((t) => t.id === trackId) ?? null,
    [chart, trackId],
  );

  const highwayNotes = useMemo(
    () => (activeTrack ? buildHighwayNotes(activeTrack, tickMap) : []),
    [activeTrack, tickMap],
  );

  const chordEvents = useMemo(
    () =>
      (chart?.chords ?? []).map((c) => ({
        mediaMs: tickMap.tickToMs(c.tick),
        symbol: c.symbol,
        confidence: c.confidence,
      })),
    [chart, tickMap],
  );

  const stringCount = activeTrack?.tuning?.strings.length ?? 6;

  const commitPoints = useCallback(
    (next: SyncPoint[]) => {
      setPoints(next);
      if (chart) {
        void saveSyncPoints(chart.id, recording, next).catch(() => {
          /* storage errors are already logged by the store */
        });
      }
    },
    [chart, recording],
  );

  const hasHighway = highwayNotes.length > 0;
  const hasNotation = !!score;

  return (
    <div className="workspace">
      <div className="workspace-toolbar">
        <div className="viewswitch">
          {(
            [
              ["split", "Split"],
              ["highway", "Highway"],
              ["notation", "Notation"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {chart && chart.tracks.length > 0 && (
          <label className="workspace-track">
            Part
            <select
              value={trackId ?? ""}
              onChange={(e) => setTrackId(e.target.value)}
            >
              {chart.tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.source === "analyzer" ? " (auto)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {(view === "split" || view === "highway") && (
          <label className="workspace-lookahead" title="How far ahead the highway shows">
            Lead
            <input
              type="range"
              min={1500}
              max={6000}
              step={250}
              value={lookAhead}
              onChange={(e) => setLookAhead(Number(e.target.value))}
            />
            <span>{(lookAhead / 1000).toFixed(1)}s</span>
          </label>
        )}

        <button
          className={showLyrics ? "active" : ""}
          onClick={() => setShowLyrics((v) => !v)}
        >
          Lyrics
        </button>

        <button
          className={syncOpen ? "active" : ""}
          onClick={() => setSyncOpen((v) => !v)}
          title="Align the chart to this recording"
        >
          Align
        </button>
      </div>

      {activeTrack?.source === "analyzer" && (
        <p className="workspace-notice">
          This part was machine-transcribed. Expect mistakes, especially on strummed
          guitar &mdash; treat it as a draft to correct.
        </p>
      )}

      <div className={`workspace-body view-${view}`}>
        {(view === "split" || view === "highway") && (
          <section className="workspace-highway">
            {hasHighway ? (
              <>
                <FretboardHighway
                  engine={engine}
                  notes={highwayNotes}
                  beats={chart?.beatGrid?.beats}
                  stringCount={stringCount}
                  lookAheadMs={lookAhead}
                />
                <ChordPanel engine={engine} chords={chordEvents} />
              </>
            ) : (
              <div className="placeholder">
                <h2>No notes to play yet</h2>
                <p className="muted">
                  Run the analyzer on your own copy of the audio, or load a Guitar Pro
                  file, and the highway will fill up.
                </p>
              </div>
            )}
          </section>
        )}

        {(view === "split" || view === "notation") && (
          <section className="workspace-notation">
            {hasNotation ? (
              <TabView
                engine={engine}
                score={score}
                trackIndex={scoreTrackIndex}
                onTracksLoaded={onScoreTracksLoaded}
              />
            ) : (
              <div className="placeholder">
                <h2>No score loaded</h2>
                <p className="muted">
                  Notation needs a Guitar Pro or MusicXML file. The highway works from
                  an analysed chart alone.
                </p>
              </div>
            )}
          </section>
        )}

        {showLyrics && (
          <aside className="workspace-lyrics">
            <LyricsView engine={engine} lyrics={lyrics} />
          </aside>
        )}
      </div>

      {syncOpen && (
        <div className="modal">
          <SyncEditor
            engine={engine}
            points={points}
            ticksPerBar={ticksPerBar}
            onChange={commitPoints}
            onClose={() => setSyncOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
