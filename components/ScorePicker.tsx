"use client";

/**
 * "Tab file" button plus the staff picker, for the jam page headers.
 */

import { SCORE_ACCEPT } from "../hooks/useScoreFile";

export interface ScorePickerProps {
  scoreName: string | null;
  scoreTracks: { index: number; name: string }[];
  scoreTrackIndex: number;
  onTrackIndex: (index: number) => void;
  onFile: (file: File) => void;
}

export function ScorePicker({
  scoreName,
  scoreTracks,
  scoreTrackIndex,
  onTrackIndex,
  onFile,
}: ScorePickerProps) {
  return (
    <div className="file-inputs">
      <label className="score-picker" title={scoreName ?? "Guitar Pro or MusicXML file"}>
        {scoreName ? "Replace tab file" : "Load tab file"}
        <input
          type="file"
          accept={SCORE_ACCEPT}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            // Allow picking the same file again after editing it.
            e.target.value = "";
          }}
        />
      </label>
      {scoreTracks.length > 1 && (
        <label>
          Staff
          <select
            value={scoreTrackIndex}
            onChange={(e) => onTrackIndex(Number(e.target.value))}
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
  );
}
