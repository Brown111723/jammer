"use client";

/**
 * Scrolling lyrics, driven from the clock at 60fps via refs (same discipline as the
 * Transport: no setState in the frame loop).
 *
 * Handles the three states LRCLIB actually returns, because conflating them makes the
 * app look broken:
 *   - synced lyrics    → scroll and highlight
 *   - unsynced lyrics  → show as a static block, don't fake a scroll
 *   - instrumental     → say so
 */

import { useEffect, useRef } from "react";
import { activeLineIndex, hasSyncedTimings } from "../lib/lyrics";
import type { SyncEngine } from "../lib/sync-engine";
import type { Lyrics } from "../lib/types";

export function LyricsView({
  engine,
  lyrics,
}: {
  engine: SyncEngine;
  lyrics: Lyrics | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const activeRef = useRef(-1);

  const synced = hasSyncedTimings(lyrics);

  useEffect(() => {
    if (!lyrics || !synced) return;

    return engine.onFrame((positionMs) => {
      const idx = activeLineIndex(lyrics.lines, positionMs);
      if (idx === activeRef.current) return;

      const prev = lineRefs.current[activeRef.current];
      if (prev) prev.classList.remove("active");

      const next = lineRefs.current[idx];
      if (next) {
        next.classList.add("active");
        const container = containerRef.current;
        if (container) {
          // Centre the active line. scrollTo with behavior:"smooth" fights the frame
          // loop when lines are close together, so set scrollTop directly and let CSS
          // scroll-behavior handle easing.
          container.scrollTop =
            next.offsetTop - container.clientHeight / 2 + next.clientHeight / 2;
        }
      }
      activeRef.current = idx;
    });
  }, [engine, lyrics, synced]);

  if (!lyrics) {
    return (
      <div className="lyrics empty">
        <p className="muted">No lyrics found for this track on LRCLIB.</p>
      </div>
    );
  }

  if (lyrics.lines.length === 0) {
    return (
      <div className="lyrics empty">
        <p className="muted">Instrumental.</p>
      </div>
    );
  }

  return (
    <div className="lyrics" ref={containerRef}>
      {!synced && (
        <p className="lyrics-notice muted">
          These lyrics have no timings on LRCLIB, so they won&rsquo;t scroll.
        </p>
      )}
      {lyrics.lines.map((line, i) => (
        <p
          key={`${line.mediaMs}-${i}`}
          ref={(el) => {
            lineRefs.current[i] = el;
          }}
          className="lyrics-line"
        >
          {line.text || " "}
        </p>
      ))}
      <p className="lyrics-credit muted">Lyrics from LRCLIB</p>
    </div>
  );
}
