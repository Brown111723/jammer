"use client";

/**
 * Visual harness for the highway.
 *
 * The perspective projection, note sizing and beat-line density are the kind of thing
 * you can only judge by looking. Needing a song loaded to see them makes tuning them
 * tedious, so this page drives the highway from a synthetic riff and a free-running
 * clock — no audio, no auth, no chart.
 *
 * Keep it. It's also the fastest way to check the highway still renders after a change.
 */

import { useEffect, useMemo, useState } from "react";
import { FretboardHighway } from "../../../components/FretboardHighway";
import { ChordPanel } from "../../../components/ChordPanel";
import { SyncEngine } from "../../../lib/sync-engine";
import type { HighwayNote } from "../../../lib/fretboard";
import type { Beat } from "../../../lib/types";

/** A free-running transport: no media, just a clock that advances. */
function useDemoEngine(playing: boolean) {
  const engine = useMemo(() => new SyncEngine(), []);

  useEffect(() => {
    engine.clock.setPlaying(playing, engine.clock.positionMs());
    // Keep the engine's duration sane so the scrub bar behaves if it's mounted.
    return () => {
      /* engine is reused across toggles */
    };
  }, [engine, playing]);

  useEffect(() => () => engine.destroy(), [engine]);

  // The engine's frame loop only starts when a transport attaches, so start it here.
  useEffect(() => {
    const unsubscribe = engine.onFrame(() => {});
    return unsubscribe;
  }, [engine]);

  return engine;
}

/** An eight-bar riff at 100 BPM: power chords, a run, and some sustains. */
function buildDemo(bpm = 100) {
  const beatMs = 60_000 / bpm;
  const notes: HighwayNote[] = [];
  const beats: Beat[] = [];
  const chords: { mediaMs: number; symbol: string }[] = [];

  for (let bar = 0; bar < 16; bar++) {
    for (let b = 0; b < 4; b++) {
      beats.push({
        mediaMs: (bar * 4 + b) * beatMs,
        beatInBar: b + 1,
        bar: bar + 1,
      });
    }
  }

  const progression = ["E5", "G5", "A5", "E5", "C", "G", "Am", "F"];
  let group = 0;

  for (let bar = 0; bar < 16; bar++) {
    const barStart = bar * 4 * beatMs;
    const symbol = progression[bar % progression.length];
    chords.push({ mediaMs: barStart, symbol });

    if (bar % 4 === 3) {
      // A little run up the neck every fourth bar.
      for (let i = 0; i < 8; i++) {
        notes.push({
          mediaMs: barStart + i * beatMs * 0.5,
          durationMs: beatMs * 0.4,
          string: 5 - (i % 3),
          fret: 5 + i,
          midi: 60 + i,
          chordGroup: group++,
        });
      }
    } else {
      // Eighth-note power chords.
      for (let i = 0; i < 8; i++) {
        const at = barStart + i * beatMs * 0.5;
        const sustain = i === 6;
        notes.push({
          mediaMs: at,
          durationMs: sustain ? beatMs * 1.5 : beatMs * 0.35,
          string: 0,
          fret: [0, 3, 5, 0][bar % 4],
          midi: 40,
          chordGroup: group,
        });
        notes.push({
          mediaMs: at,
          durationMs: sustain ? beatMs * 1.5 : beatMs * 0.35,
          string: 1,
          fret: [2, 5, 7, 2][bar % 4],
          midi: 47,
          chordGroup: group,
        });
        group++;
      }
    }
  }

  notes.sort((a, b) => a.mediaMs - b.mediaMs || a.string - b.string);
  return { notes, beats, chords };
}

export default function HighwayDemoPage() {
  const [playing, setPlaying] = useState(true);
  const [lookAhead, setLookAhead] = useState(3000);
  const [strings, setStrings] = useState(6);
  const engine = useDemoEngine(playing);

  const { notes, beats, chords } = useMemo(() => buildDemo(), []);

  return (
    <main className="jam">
      <header className="jam-header">
        <h1>Highway harness</h1>
        <button onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <button onClick={() => engine.clock.seek(0)}>Restart</button>
        <label>
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
        <label>
          Strings
          <select
            value={strings}
            onChange={(e) => setStrings(Number(e.target.value))}
          >
            <option value={6}>6 (guitar)</option>
            <option value={4}>4 (bass)</option>
          </select>
        </label>
        <span className="muted">Synthetic riff — no audio.</span>
      </header>

      <div className="workspace">
        <div className="workspace-body view-highway">
          <section className="workspace-highway">
            <FretboardHighway
              engine={engine}
              notes={notes}
              beats={beats}
              stringCount={strings}
              lookAheadMs={lookAhead}
            />
            <ChordPanel engine={engine} chords={chords} />
          </section>
        </div>
      </div>
    </main>
  );
}
