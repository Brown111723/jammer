"use client";

/**
 * Paste a chord sheet, time it against the recording, save it as a chart.
 *
 * Three steps, and the middle one is the whole point:
 *
 *   1. Paste   — text from anywhere. Parsed immediately so you can see it worked.
 *   2. Time    — play the song and tap on each chord change. One pass, once, ever.
 *   3. Done    — saved, synced, and auto-matched to any other version of the song.
 *
 * The timing pass shows the current chord large, the next one beside it, and the lyric
 * the chord sits over — so you can follow the sheet by ear without reading ahead.
 * Undo is prominent because you will miss one, and having to restart a four-minute
 * song over a single fumble would make the feature unusable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChordDiagram } from "./ChordPanel";
import { saveChart } from "../lib/chart-store";
import { chartFromTimedChords, timedChordsFromTempo, type TimedChord } from "../lib/chord-chart";
import { collapseRepeats, parseChordSheet, type ParsedChordSheet } from "../lib/chord-sheet";
import type { SyncEngine } from "../lib/sync-engine";
import type { JammerChart, RecordingRef } from "../lib/types";

export interface ChordSheetImportProps {
  engine: SyncEngine;
  recording: RecordingRef;
  title: string;
  artist: string;
  onImported: (chart: JammerChart) => void;
  onClose: () => void;
}

type Step = "paste" | "time" | "done";

export function ChordSheetImport({
  engine,
  recording,
  title,
  artist,
  onImported,
  onClose,
}: ChordSheetImportProps) {
  const [step, setStep] = useState<Step>("paste");
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedChordSheet | null>(null);
  const [collapse, setCollapse] = useState(true);
  const [withStrums, setWithStrums] = useState(true);

  const [taps, setTaps] = useState<TimedChord[]>([]);
  const [saving, setSaving] = useState(false);
  const positionRef = useRef(0);
  const clockRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return engine.onFrame((positionMs) => {
      positionRef.current = positionMs;
      if (clockRef.current) clockRef.current.textContent = fmt(positionMs);
    });
  }, [engine]);

  const sequence = useMemo(() => {
    if (!parsed) return [];
    return collapse ? collapseRepeats(parsed.sequence) : parsed.sequence;
  }, [parsed, collapse]);

  const doParse = useCallback(
    (value: string) => {
      setText(value);
      setParsed(value.trim() ? parseChordSheet(value) : null);
    },
    [],
  );

  const nextIndex = taps.length;
  const currentChord = sequence[nextIndex];
  const followingChord = sequence[nextIndex + 1];
  const finished = nextIndex >= sequence.length;

  const tap = useCallback(() => {
    if (finished || !currentChord) return;
    setTaps((t) => [
      ...t,
      {
        symbol: currentChord.symbol,
        mediaMs: positionRef.current,
        sectionLabel: currentChord.sectionLabel,
      },
    ]);
  }, [finished, currentChord]);

  const undo = useCallback(() => setTaps((t) => t.slice(0, -1)), []);

  useEffect(() => {
    if (step !== "time") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;

      if (e.code === "Space") {
        e.preventDefault();
        tap();
      } else if (e.code === "Backspace" || e.code === "KeyZ") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, tap, undo]);

  const save = useCallback(
    async (timed: TimedChord[]) => {
      if (timed.length === 0) return;
      setSaving(true);
      try {
        const chart = chartFromTimedChords(timed, {
          title,
          artist,
          recording,
          capo: parsed?.capo,
          key: parsed?.key,
          withStrums,
        });
        await saveChart(chart);
        onImported(chart);
        setStep("done");
      } finally {
        setSaving(false);
      }
    },
    [title, artist, recording, parsed, withStrums, onImported],
  );

  // ---------------------------------------------------------------- paste

  if (step === "paste") {
    return (
      <div className="sheet-import">
        <header>
          <h2>Add chords</h2>
          <button onClick={onClose} aria-label="Close">×</button>
        </header>

        <p className="muted">
          Open a chord sheet anywhere, copy the text and paste it here. Both the
          common chords-above-lyrics layout and ChordPro brackets work.
        </p>

        <textarea
          className="sheet-input"
          value={text}
          onChange={(e) => doParse(e.target.value)}
          placeholder={"[Verse 1]\nC                G\nSomebody once told me\n..."}
          rows={10}
          autoFocus
        />

        {parsed && (
          <div className="sheet-preview">
            {parsed.warnings.map((w) => (
              <p key={w} className="warn">{w}</p>
            ))}

            {parsed.sequence.length > 0 && (
              <>
                <p>
                  <strong>{parsed.sequence.length}</strong> chords
                  {collapse && sequence.length !== parsed.sequence.length && (
                    <> &rarr; <strong>{sequence.length}</strong> changes</>
                  )}
                  {parsed.sections.length > 1 && (
                    <> across {parsed.sections.length} sections</>
                  )}
                  {parsed.capo !== undefined && <> &middot; capo {parsed.capo}</>}
                  {parsed.key && <> &middot; key {parsed.key}</>}
                </p>

                <div className="sheet-shapes">
                  {parsed.distinctChords.slice(0, 12).map((symbol) => (
                    <ChordDiagram key={symbol} symbol={symbol} size="small" />
                  ))}
                </div>

                <label className="sheet-option">
                  <input
                    type="checkbox"
                    checked={collapse}
                    onChange={(e) => setCollapse(e.target.checked)}
                  />
                  Merge repeated chords &mdash; tap only when the chord actually changes
                </label>
                <label className="sheet-option">
                  <input
                    type="checkbox"
                    checked={withStrums}
                    onChange={(e) => setWithStrums(e.target.checked)}
                  />
                  Show chord shapes on the highway as strums
                </label>
              </>
            )}
          </div>
        )}

        <div className="sheet-actions">
          <button
            className="primary"
            disabled={sequence.length === 0}
            onClick={() => {
              setTaps([]);
              setStep("time");
            }}
          >
            Next: time it &rarr;
          </button>
          {sequence.length > 0 && (
            <button
              onClick={() =>
                void save(
                  timedChordsFromTempo(sequence, 120, positionRef.current, 4),
                )
              }
            >
              Skip &mdash; estimate at 120 BPM
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- time

  if (step === "time") {
    const progress = sequence.length ? (nextIndex / sequence.length) * 100 : 0;

    return (
      <div className="sheet-import timing">
        <header>
          <h2>Tap the changes</h2>
          <button onClick={onClose} aria-label="Close">×</button>
        </header>

        <p className="muted">
          Press play, then hit <kbd>space</kbd> the moment each chord lands.{" "}
          <kbd>Z</kbd> undoes a fumble. You only ever do this once for this song.
        </p>

        <div className="sheet-progress">
          <div style={{ width: `${progress}%` }} />
        </div>

        <div className="sheet-now">
          {finished ? (
            <div className="sheet-complete">
              <p className="big">All {taps.length} timed</p>
            </div>
          ) : (
            <>
              <div className="sheet-current">
                {currentChord?.sectionLabel && (
                  <span className="sheet-section">{currentChord.sectionLabel}</span>
                )}
                <ChordDiagram symbol={currentChord?.symbol ?? null} size="large" />
                {currentChord?.lyricHint && (
                  <p className="sheet-lyric">&ldquo;{currentChord.lyricHint}&rdquo;</p>
                )}
              </div>
              <div className="sheet-next">
                <span className="chordpanel-label">Next</span>
                <ChordDiagram symbol={followingChord?.symbol ?? null} size="small" />
              </div>
            </>
          )}
        </div>

        <button className="tap-big" onClick={tap} disabled={finished}>
          {finished ? "Done" : `Tap — ${currentChord?.symbol ?? ""}`}
        </button>

        <p className="muted sheet-status">
          {nextIndex} / {sequence.length} &middot; <span ref={clockRef}>0:00</span>
        </p>

        <div className="sheet-actions">
          <button onClick={undo} disabled={taps.length === 0}>
            Undo
          </button>
          <button onClick={() => setTaps([])} disabled={taps.length === 0}>
            Start over
          </button>
          <button
            className="primary"
            disabled={taps.length < 2 || saving}
            onClick={() => void save(taps)}
          >
            {saving ? "Saving…" : `Save ${taps.length} chords`}
          </button>
        </div>

        {taps.length > 0 && !finished && (
          <p className="muted small">
            You can save part-way through &mdash; the chords you&rsquo;ve timed will
            work, and the rest of the song simply won&rsquo;t have any.
          </p>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- done

  return (
    <div className="sheet-import">
      <header>
        <h2>Saved</h2>
        <button onClick={onClose} aria-label="Close">×</button>
      </header>
      <p>
        {taps.length} chords, synced to this recording. It&rsquo;ll load automatically
        next time &mdash; and it&rsquo;ll be found for any other version of this song
        too, since charts aren&rsquo;t tied to one recording.
      </p>
      <p className="muted">
        If anything drifts, the <strong>Align</strong> tool will nudge it.
      </p>
      <div className="sheet-actions">
        <button className="primary" onClick={onClose}>
          Start jamming
        </button>
      </div>
    </div>
  );
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
