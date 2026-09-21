"use client";

/**
 * alphaTab renderer wired to the SyncEngine.
 *
 * Key detail: alphaTab must be created with
 * `player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia`. In that mode its
 * synthesiser is off and it expects an external time source — which is exactly our
 * clock. Get this wrong and `api.player.output` won't be an external-media output and
 * SyncEngine.attachAlphaTab throws with a message saying so.
 *
 * alphaTab is imported dynamically because it touches `window` at module scope and will
 * break a Next.js server render otherwise.
 */

import { useEffect, useRef, useState } from "react";
import type { SyncEngine, AlphaTabApiLike } from "../lib/sync-engine";
import type { InstrumentKind } from "../lib/types";

export interface TabViewProps {
  engine: SyncEngine;
  /** A .gp/.gp5/.gpx/.musicxml file as bytes, or an alphaTex string. */
  score: ArrayBuffer | string | null;
  /** Which track index to display. */
  trackIndex?: number;
  instrument?: InstrumentKind;
  onReady?: (api: AlphaTabApiLike) => void;
  onTracksLoaded?: (tracks: { index: number; name: string }[]) => void;
}

export function TabView({
  engine,
  score,
  trackIndex = 0,
  onReady,
  onTracksLoaded,
}: TabViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<AlphaTabApiLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The renderer is created asynchronously (dynamic import), but the page usually
  // mounts this component with the score ALREADY set. Loading the score from a normal
  // effect therefore ran before the renderer existed, found nothing, and gave up — the
  // file was never passed in and the view sat on "Rendering…" forever. The boot step
  // now reads the latest score from these refs once the renderer is ready.
  const scoreRef = useRef(score);
  const trackIndexRef = useRef(trackIndex);
  const onReadyRef = useRef(onReady);
  const onTracksLoadedRef = useRef(onTracksLoaded);
  scoreRef.current = score;
  trackIndexRef.current = trackIndex;
  onReadyRef.current = onReady;
  onTracksLoadedRef.current = onTracksLoaded;

  useEffect(() => {
    let disposed = false;
    let api: AlphaTabApiLike | null = null;

    async function boot() {
      if (!hostRef.current) return;
      try {
        const alphaTab = await import("@coderline/alphatab");
        if (disposed) return;

        api = new alphaTab.AlphaTabApi(hostRef.current, {
          core: {
            // Serve these from /public/alphatab/ — see scripts/postinstall.
            fontDirectory: "/alphatab/font/",
            scriptFile: "/alphatab/alphaTab.min.js",
            // Render on the main thread, not in a web worker.
            //
            // alphaTab locates its worker script relative to its own module URL. Under
            // Next.js's bundler that URL becomes a file:///.../node_modules/... path
            // the browser cannot fetch, so the worker never starts and the score is
            // never drawn (alphaTab logs "Detected bundling with WebPack but
            // @coderline/alphatab-webpack was not used"). The bundler plugin fixes
            // that but ties us to webpack specifics; one score on the main thread is
            // fast enough, and this works identically in dev, prod and on a phone.
            useWorkers: false,
          },
          display: {
            staveProfile: "ScoreTab",
            scale: 1.0,
          },
          notation: {
            // `elements` is a Map keyed by the NotationElement enum, not an object
            // literal — the object form in some older examples won't typecheck.
            //
            // We hide the score header because Jammer already shows the title and
            // artist in the transport bar, and a second copy scrolling away at the top
            // of the tab just wastes vertical space.
            elements: new Map([
              [alphaTab.NotationElement.ScoreTitle, false],
              [alphaTab.NotationElement.ScoreSubTitle, false],
              [alphaTab.NotationElement.ScoreArtist, false],
              [alphaTab.NotationElement.ScoreAlbum, false],
            ]),
          },
          player: {
            // THE critical setting. Without it there is no external-media output and
            // the sync engine has nothing to push position into.
            playerMode: alphaTab.PlayerMode.EnabledExternalMedia,
            enableCursor: true,
            enableElementHighlighting: true,
            enableUserInteraction: true,
            scrollMode: alphaTab.ScrollMode.Continuous,
            // The element that actually scrolls: the notation pane in the workspace.
            // (Pointing at a non-scrolling wrapper left the cursor moving off-screen
            // while the view stayed on bar 1.)
            scrollElement:
              (hostRef.current.closest(".workspace-notation") as HTMLElement | null) ??
              hostRef.current.parentElement ??
              undefined,
          },
        }) as never as AlphaTabApiLike;

        apiRef.current = api;

        const withEvents = api as never as {
          scoreLoaded: { on(cb: (score: never) => void): void };
          renderStarted: { on(cb: () => void): void };
          renderFinished: { on(cb: () => void): void };
          error: { on(cb: (e: never) => void): void };
          renderTracks(tracks: never[]): void;
          score: never;
        };

        withEvents.scoreLoaded.on(((loaded: {
          tracks: { name: string }[];
        }) => {
          onTracksLoadedRef.current?.(
            loaded.tracks.map((t, index) => ({ index, name: t.name })),
          );
        }) as never);

        withEvents.renderFinished.on(() => {
          if (!disposed) setLoading(false);
        });

        withEvents.error.on(((e: { message?: string }) => {
          if (!disposed) setError(e?.message ?? "alphaTab failed to render.");
        }) as never);

        // A failure to hook up cursor sync shouldn't stop the notation rendering.
        // Show the score either way; say so if the cursor won't follow.
        try {
          engine.attachAlphaTab(api);
        } catch (syncErr) {
          console.warn("[jammer] cursor sync unavailable:", syncErr);
        }
        onReadyRef.current?.(api);

        // Load whatever score arrived while alphaTab was still being imported.
        loadInto(api, scoreRef.current, trackIndexRef.current);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void boot();

    return () => {
      disposed = true;
      engine.detachAlphaTab();
      (api as never as { destroy?(): void } | null)?.destroy?.();
      apiRef.current = null;
    };
  }, [engine]);

  function loadInto(
    api: AlphaTabApiLike | null,
    data: ArrayBuffer | string | null,
    track: number,
  ) {
    const target = api as never as {
      load(data: unknown, tracks?: number[]): boolean;
      tex(source: string): void;
    } | null;
    if (!target || !data) return;

    setError(null);
    setLoading(true);
    try {
      if (typeof data === "string") {
        target.tex(data);
      } else {
        // Pass a copy: alphaTab may hold on to or transfer the buffer, and the page
        // keeps the original to reload when the track changes.
        const ok = target.load(new Uint8Array(data.slice(0)), [track]);
        if (ok === false) {
          setError(
            "alphaTab didn't recognise this file. Supported: Guitar Pro 3–7 " +
              "(.gp3 .gp4 .gp5 .gpx .gp), MusicXML and alphaTex.",
          );
          setLoading(false);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  // A NEW score after the renderer exists. (The first one is picked up by boot.)
  useEffect(() => {
    if (apiRef.current) loadInto(apiRef.current, score, trackIndexRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  // Switch rendered track without reloading the file.
  useEffect(() => {
    const api = apiRef.current as never as {
      score?: { tracks: never[] };
      renderTracks(tracks: never[]): void;
    } | null;
    if (!api?.score) return;
    const track = api.score.tracks[trackIndex];
    if (track) api.renderTracks([track]);
  }, [trackIndex]);

  return (
    <div className="tabview">
      {error && (
        <div className="tabview-error">
          <strong>Could not render the score.</strong>
          <p>{error}</p>
        </div>
      )}
      {loading && !error && <div className="tabview-loading">Rendering&hellip;</div>}
      <div ref={hostRef} className="tabview-host" />
    </div>
  );
}
