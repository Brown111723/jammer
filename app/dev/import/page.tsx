"use client";

/**
 * Visual harness for the chord-sheet importer.
 *
 * The importer is normally reached from a jam page, which needs a live track. This
 * mounts it against a free-running clock and a sample sheet so the paste, preview and
 * tap-along steps can be worked on without a song loaded.
 */

import { useEffect, useMemo, useState } from "react";
import { ChordSheetImport } from "../../../components/ChordSheetImport";
import { SyncEngine } from "../../../lib/sync-engine";

const SAMPLE = `Wonderwall - Oasis
Capo: 2

[Intro]
Em7  G  Dsus4  A7sus4

[Verse 1]
Em7           G
Today is gonna be the day
        Dsus4                A7sus4
That they're gonna throw it back to you

[Chorus]
       C         Em7
Because maybe
          G             Em7
You're gonna be the one that saves me`;

export default function ImportHarness() {
  const engine = useMemo(() => new SyncEngine(), []);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    engine.clock.setPlaying(true, 0);
    const unsubscribe = engine.onFrame(() => {});
    return () => {
      unsubscribe();
      engine.destroy();
    };
  }, [engine]);

  return (
    <main className="jam">
      <header className="jam-header">
        <h1>Importer harness</h1>
        <button onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Open importer"}
        </button>
        <span className="muted">
          Free-running clock, no audio. Sample sheet is pre-filled in the console.
        </span>
      </header>

      <div style={{ padding: "1rem" }}>
        <p className="muted">Sample sheet to paste:</p>
        <pre
          style={{
            fontSize: "0.75rem",
            background: "var(--panel)",
            padding: "1rem",
            borderRadius: "10px",
            overflow: "auto",
          }}
        >
          {SAMPLE}
        </pre>
      </div>

      {open && (
        <div className="modal">
          <ChordSheetImport
            engine={engine}
            recording={{ transport: "local", id: "harness" }}
            title="Wonderwall"
            artist="Oasis"
            onImported={(chart) =>
              console.log("[harness] imported", chart.chords.length, "chords")
            }
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </main>
  );
}
