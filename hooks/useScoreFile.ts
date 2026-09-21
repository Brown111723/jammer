"use client";

/**
 * A Guitar Pro / MusicXML file, loaded once and remembered per song.
 *
 * Picking a file does three things:
 *   1. alphaTab draws it as notation (the file itself is the score);
 *   2. it's converted into a Jammer chart, so the highway, the chord panel, loops,
 *      tempo and sections all come from it — not just the notation pane;
 *   3. both are saved: the chart with the others, the file in IndexedDB, and this
 *      recording is linked to the chart.
 *
 * Next time the song opens — on YouTube, Spotify or a local copy — the chart is found
 * by title and artist, and this hook pulls the file back out of storage and hands it
 * to the notation view. Download from Ultimate Guitar (or anywhere) once, pick it
 * once, and it's just there from then on.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadScoreFile, saveScoreFile } from "../lib/blob-store";
import { normaliseForMatch, saveChart, saveSyncPoints } from "../lib/chart-store";
import { scoreToChart, type AlphaTabModule } from "../lib/score-import";
import type { JammerChart, RecordingRef } from "../lib/types";

export interface UseScoreFileOptions {
  recording: RecordingRef;
  /** The song's name as the player shows it — what later lookups search by. */
  title?: string;
  artist?: string;
  chart: JammerChart | null;
  setChart: (chart: JammerChart) => void;
}

export const SCORE_ACCEPT = ".gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.xml,.mxl";

export function useScoreFile({
  recording,
  title,
  artist,
  chart,
  setChart,
}: UseScoreFileOptions) {
  const [score, setScore] = useState<ArrayBuffer | string | null>(null);
  const [scoreTracks, setScoreTracks] = useState<{ index: number; name: string }[]>([]);
  const [scoreTrackIndex, setScoreTrackIndex] = useState(0);
  const [scoreMessage, setScoreMessage] = useState<string | null>(null);
  const [scoreName, setScoreName] = useState<string | null>(null);
  /** Which chart's file is showing, so it isn't fetched again on every render. */
  const shownFor = useRef<string | null>(null);

  // A chart that came from a file: fetch the file back for the notation view.
  useEffect(() => {
    if (!chart?.scoreFile || shownFor.current === chart.id) return;
    const id = chart.id;
    shownFor.current = id;
    void loadScoreFile(id).then((stored) => {
      if (!stored || shownFor.current !== id) return;
      setScore(stored.bytes);
      setScoreName(stored.name);
      setScoreTrackIndex(0);
    });
  }, [chart]);

  const openScoreFile = useCallback(
    async (file: File) => {
      const bytes = await file.arrayBuffer();
      // Show the notation straight away; the conversion below is extra.
      setScore(bytes);
      setScoreName(file.name);
      setScoreTrackIndex(0);
      setScoreMessage(null);

      try {
        const alphaTab = await import("@coderline/alphatab");
        const settings = new alphaTab.Settings();
        const parsed = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
          new Uint8Array(bytes),
          settings,
        );

        // Same song, same id: loading a better file replaces the old one rather than
        // leaving two charts to choose between.
        const songKey = `${normaliseForMatch(artist ?? "")}:${normaliseForMatch(title ?? "")}`;
        const id = chart?.scoreFile
          ? chart.id
          : title
            ? `score:${songKey}`
            : crypto.randomUUID();

        const next = scoreToChart(alphaTab as unknown as AlphaTabModule, parsed as never, {
          recording,
          fileName: file.name,
          fileSize: file.size,
          settings,
          id,
          title,
          artist,
        });

        shownFor.current = next.id;
        setChart(next);

        let remembered = true;
        try {
          await saveChart(next);
          await saveSyncPoints(next.id, recording, next.syncSets[0]?.points ?? []);
        } catch {
          remembered = false;
        }
        if (remembered) remembered = await saveScoreFile(next.id, file.name, bytes);

        const notes = next.tracks.reduce((n, t) => n + (t.notes?.length ?? 0), 0);
        setScoreMessage(
          `${file.name}: ${next.tracks.length} part${next.tracks.length === 1 ? "" : "s"}, ` +
            `${notes.toLocaleString()} notes, ${next.chords.length} chord changes. ` +
            (remembered
              ? "Saved — it will load by itself next time you play this song."
              : "This browser wouldn't let Jammer keep it, so you'll need to pick it again next time."),
        );
      } catch (err) {
        setScoreMessage(
          `Showing the notation, but couldn't build the highway from it: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    [artist, chart, recording, setChart, title],
  );

  return {
    score,
    scoreName,
    scoreTracks,
    setScoreTracks,
    scoreTrackIndex,
    setScoreTrackIndex,
    scoreMessage,
    dismissScoreMessage: () => setScoreMessage(null),
    openScoreFile,
  };
}
