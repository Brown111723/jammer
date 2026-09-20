"use client";

/**
 * Transpose / capo / tuning controls.
 *
 * The UI's job here is mostly to stop people expecting the impossible. There are two
 * different operations and they behave differently per transport:
 *
 *   Tuning + capo   — changes your fingering, not the sound. The recording still
 *                     matches. Works on Spotify, YouTube and local files alike.
 *
 *   Pitch           — changes the actual audio. Only possible on local files, because
 *                     streamed audio is DRM-protected. On a stream the control is
 *                     disabled with an explanation, not hidden — hiding it just makes
 *                     people hunt for it.
 *
 * When someone reaches for pitch on a stream, the panel offers the thing that WILL
 * work: retune the chart instead, which sounds identical and needs no processing.
 */

import { useCallback, useMemo } from "react";
import {
  DEFAULT_FRETBOARD,
  TUNINGS,
  describeTuning,
  semitoneLabel,
  uniformOffsetFromStandard,
  type FretboardConfig,
} from "../lib/transpose";

export interface TransposePanelProps {
  config: FretboardConfig;
  onChange: (config: FretboardConfig) => void;
  /** Only local files can have their audio processed. */
  canShiftAudio: boolean;
  /** Current audio shift, semitones. */
  audioSemitones: number;
  onAudioShift?: (semitones: number) => void;
  /** 0..1 while a shift is rendering. */
  shiftProgress?: number | null;
}

export function TransposePanel({
  config,
  onChange,
  canShiftAudio,
  audioSemitones,
  onAudioShift,
  shiftProgress,
}: TransposePanelProps) {
  const tuningKey = useMemo(() => {
    for (const [key, t] of Object.entries(TUNINGS)) {
      if (
        t.strings.length === config.tuning.length &&
        t.strings.every((n, i) => n === config.tuning[i])
      ) {
        return key;
      }
    }
    return "custom";
  }, [config.tuning]);

  const tuningOffset = uniformOffsetFromStandard(config.tuning);

  const set = useCallback(
    (patch: Partial<FretboardConfig>) => onChange({ ...config, ...patch }),
    [config, onChange],
  );

  const busy = shiftProgress !== null && shiftProgress !== undefined;

  return (
    <div className="transpose">
      <div className="transpose-row">
        <label>
          Tuning
          <select
            value={tuningKey}
            onChange={(e) => {
              const t = TUNINGS[e.target.value];
              if (t) set({ tuning: t.strings });
            }}
          >
            {Object.entries(TUNINGS).map(([key, t]) => (
              <option key={key} value={key}>
                {t.label}
              </option>
            ))}
            {tuningKey === "custom" && (
              <option value="custom">{describeTuning(config.tuning)}</option>
            )}
          </select>
        </label>

        <label>
          Capo
          <select
            value={config.capo}
            onChange={(e) => set({ capo: Number(e.target.value) })}
          >
            {Array.from({ length: 13 }, (_, i) => (
              <option key={i} value={i}>
                {i === 0 ? "None" : `Fret ${i}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="transpose-note muted">
        Tuning and capo change <strong>where you put your fingers</strong>, not what
        comes out. The recording still matches, on every source.
        {tuningOffset !== null && tuningOffset !== 0 && (
          <>
            {" "}
            This tuning is {Math.abs(tuningOffset)} semitone
            {Math.abs(tuningOffset) === 1 ? "" : "s"}{" "}
            {tuningOffset < 0 ? "below" : "above"} standard.
          </>
        )}
      </p>

      <div className="transpose-row">
        <span className="transpose-label">Audio pitch</span>
        <div className="transpose-stepper">
          <button
            disabled={!canShiftAudio || busy || audioSemitones <= -6}
            onClick={() => onAudioShift?.(audioSemitones - 1)}
          >
            −
          </button>
          <span className="transpose-value">{semitoneLabel(audioSemitones)}</span>
          <button
            disabled={!canShiftAudio || busy || audioSemitones >= 6}
            onClick={() => onAudioShift?.(audioSemitones + 1)}
          >
            +
          </button>
          {audioSemitones !== 0 && canShiftAudio && !busy && (
            <button onClick={() => onAudioShift?.(0)}>Reset</button>
          )}
        </div>
      </div>

      {busy && (
        <div className="transpose-progress">
          <div style={{ width: `${Math.round((shiftProgress ?? 0) * 100)}%` }} />
        </div>
      )}

      {canShiftAudio ? (
        <p className="transpose-note muted">
          Shifts the pitch without changing the tempo. Takes a few seconds to render
          and is cached per semitone. Beyond about ±3 it starts to sound processed.
        </p>
      ) : (
        <p className="transpose-note warn">
          Audio pitch can&rsquo;t be changed on a stream &mdash; Spotify and YouTube
          audio is DRM-protected, so there are no samples to process. Use{" "}
          <strong>Tuning</strong> above instead: retune your guitar and Jammer re-frets
          the chart, which sounds identical against the untouched recording. Or load a
          local copy of the file.
        </p>
      )}

      {(config.capo !== 0 ||
        config.transposeSemitones !== 0 ||
        tuningKey !== "standard") && (
        <button
          className="transpose-reset"
          onClick={() => onChange(DEFAULT_FRETBOARD)}
        >
          Reset fretboard
        </button>
      )}
    </div>
  );
}
