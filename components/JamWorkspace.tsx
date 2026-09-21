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
import { ChordSheetImport } from "./ChordSheetImport";
import { ChordSources } from "./ChordSources";
import { LoopControls } from "./LoopControls";
import { TransposePanel } from "./TransposePanel";
import { FretboardHighway } from "./FretboardHighway";
import { LyricsView } from "./LyricsView";
import { SyncEditor } from "./SyncEditor";
import { TabView } from "./TabView";
import { buildHighwayNotes } from "../lib/fretboard";
import { applyFretboard, DEFAULT_FRETBOARD, type FretboardConfig } from "../lib/transpose";
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
  /** Only local files can have their audio pitch-shifted. */
  canShiftAudio?: boolean;
  audioSemitones?: number;
  onAudioShift?: (semitones: number) => void;
  shiftProgress?: number | null;
  /** Song metadata, for chord-site links and for a chart built from a pasted sheet. */
  songTitle?: string;
  songArtist?: string;
  onChartImported?: (chart: JammerChart) => void;
}

export function JamWorkspace({
  engine,
  chart,
  recording,
  lyrics,
  score,
  onScoreTracksLoaded,
  scoreTrackIndex = 0,
  canShiftAudio = false,
  audioSemitones = 0,
  onAudioShift,
  shiftProgress = null,
  songTitle,
  songArtist,
  onChartImported,
}: JamWorkspaceProps) {
  const [view, setView] = useState<JamView>("split");
  const [trackId, setTrackId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [points, setPoints] = useState<SyncPoint[]>([]);
  const [lookAhead, setLookAhead] = useState(3000);
  const [showLyrics, setShowLyrics] = useState(true);
  const [fretboard, setFretboard] = useState<FretboardConfig>(DEFAULT_FRETBOARD);
  const [showTranspose, setShowTranspose] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [importing, setImporting] = useState(false);

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

  // Default to the first playable track — and pick again when a different chart
  // arrives (a tab file replacing a chord sheet), or the old id points at nothing.
  useEffect(() => {
    if (!chart) return;
    if (trackId && chart.tracks.some((t) => t.id === trackId)) return;
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

  // A chart from a notation file carries the file's own timing. alphaTab's cursor and
  // the beat grid are in that timing; the user's alignment maps ticks to THIS
  // recording. Route both through ticks so the cursor, highway and loop points all
  // follow the alignment.
  const nativeMap = useMemo(
    () =>
      chart?.scoreTiming?.length
        ? new TickMap(chart.scoreTiming, chart.tempos[0]?.bpm ?? 120, chart.ppq ?? PPQ)
        : null,
    [chart],
  );

  useEffect(() => {
    if (!nativeMap) {
      engine.setScoreTimeMap(null);
      return;
    }
    engine.setScoreTimeMap({
      toScore: (ms) => nativeMap.tickToMs(tickMap.msToTick(ms)),
      fromScore: (ms) => tickMap.tickToMs(nativeMap.msToTick(ms)),
    });
    return () => engine.setScoreTimeMap(null);
  }, [engine, nativeMap, tickMap]);

  const beats = useMemo(() => {
    const raw = chart?.beatGrid?.beats;
    if (!raw || !nativeMap) return raw;
    return raw.map((b) => ({ ...b, mediaMs: tickMap.tickToMs(nativeMap.msToTick(b.mediaMs)) }));
  }, [chart, nativeMap, tickMap]);

  // Everything downstream reads the adjusted chart, so capo/tuning changes flow
  // through the highway, the chord panel and the notation together.
  const adjusted = useMemo(
    () => (chart ? applyFretboard(chart, fretboard) : null),
    [chart, fretboard],
  );

  const activeTrack = useMemo(
    () => adjusted?.tracks.find((t) => t.id === trackId) ?? null,
    [adjusted, trackId],
  );

  const highwayNotes = useMemo(
    () => (activeTrack ? buildHighwayNotes(activeTrack, tickMap) : []),
    [activeTrack, tickMap],
  );

  const chordEvents = useMemo(
    () =>
      (adjusted?.chords ?? []).map((c) => ({
        mediaMs: tickMap.tickToMs(c.tick),
        symbol: c.symbol,
        confidence: c.confidence,
      })),
    [adjusted, tickMap],
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

        {adjusted && adjusted.tracks.length > 0 && (
          <label className="workspace-track">
            Part
            <select
              value={trackId ?? ""}
              onChange={(e) => setTrackId(e.target.value)}
            >
              {adjusted.tracks.map((t) => (
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
          className={showTranspose ? "active" : ""}
          onClick={() => setShowTranspose((v) => !v)}
          title="Tuning, capo and pitch"
        >
          Transpose
        </button>

        <button
          className={syncOpen ? "active" : ""}
          onClick={() => setSyncOpen((v) => !v)}
          title="Align the chart to this recording"
        >
          Align
        </button>

        <LoopControls
          engine={engine}
          beats={beats}
          countIn={countIn}
          onCountInChange={setCountIn}
        />
      </div>

      {showTranspose && (
        <TransposePanel
          config={fretboard}
          onChange={setFretboard}
          canShiftAudio={canShiftAudio}
          audioSemitones={audioSemitones}
          onAudioShift={onAudioShift}
          shiftProgress={shiftProgress}
        />
      )}

      {songTitle && (adjusted?.chords.length ?? 0) === 0 && (
        <ChordSources
          title={songTitle}
          artist={songArtist ?? ""}
          onPaste={onChartImported ? () => setImporting(true) : undefined}
        />
      )}

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
                  beats={beats}
                  stringCount={stringCount}
                  lookAheadMs={lookAhead}
                />
                <ChordPanel engine={engine} chords={chordEvents} />
              </>
            ) : (
              <div className="placeholder">
                <h2>No notes to play yet</h2>
                <p className="muted">
                  Load a tab file (Guitar Pro .gp/.gp5/.gpx or MusicXML) with the
                  button at the top and the highway fills up. You only need to do it
                  once per song.
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

      {importing && songTitle && onChartImported && (
        <div className="modal">
          <ChordSheetImport
            engine={engine}
            recording={recording}
            title={songTitle}
            artist={songArtist ?? ""}
            onImported={(chart) => {
              onChartImported(chart);
              setImporting(false);
            }}
            onClose={() => setImporting(false)}
          />
        </div>
      )}

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
