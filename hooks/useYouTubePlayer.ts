"use client";

/**
 * Loads the YouTube IFrame API and creates a player bound to a container element.
 *
 * Notes that matter:
 *
 *  - The API loads once per page and signals readiness through a single global
 *    callback, `window.onYouTubePlayerAPIReady`. Two components racing to define it
 *    will clobber each other, so loading is memoised at module scope.
 *
 *  - `playerVars.autoplay` is deliberately 0. Browsers block unmuted autoplay without
 *    a user gesture; a player that silently refuses to start looks broken. The user
 *    presses play.
 *
 *  - `origin` should be set to the page origin. Without it some browsers log
 *    cross-origin warnings and postMessage can be unreliable.
 *
 *  - The container element is REPLACED by the iframe, so the ref must point at a
 *    disposable child div, not at a wrapper you also style.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  YouTubeTransport,
  youtubeErrorMessage,
  type YouTubePlayerInstance,
} from "../lib/transports/youtube-transport";

const API_URL = "https://www.youtube.com/iframe_api";

export type YouTubeStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string; hint?: string };

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, opts: unknown) => YouTubePlayerInstance;
      PlayerState: Record<string, number>;
    };
    onYouTubePlayerAPIReady?: () => void;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.YT?.Player) return resolve();

    // YouTube has used both names over the years; define both.
    const done = () => resolve();
    window.onYouTubePlayerAPIReady = done;
    window.onYouTubeIframeAPIReady = done;

    const script = document.createElement("script");
    script.src = API_URL;
    script.async = true;
    script.onerror = () =>
      reject(
        new Error(
          "Could not load the YouTube IFrame API. An ad or tracker blocker is the " +
            "usual cause.",
        ),
      );
    document.head.appendChild(script);
  });

  return apiPromise;
}

export function useYouTubePlayer(videoId: string | null, startSeconds = 0) {
  const [status, setStatus] = useState<YouTubeStatus>({ kind: "idle" });
  const [transport, setTransport] = useState<YouTubeTransport | null>(null);
  const [rates, setRates] = useState<number[]>([1]);

  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const transportRef = useRef<YouTubeTransport | null>(null);

  const mount = useCallback(async () => {
    if (!videoId || !hostRef.current) return;
    setStatus({ kind: "loading" });

    try {
      await loadApi();
      if (!hostRef.current) return;

      // The API replaces this node, so give it a fresh child to consume.
      const target = document.createElement("div");
      hostRef.current.innerHTML = "";
      hostRef.current.appendChild(target);

      const player = new window.YT!.Player(target, {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          start: Math.max(0, Math.floor(startSeconds)),
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            const t = new YouTubeTransport(player, videoId);
            transportRef.current = t;
            setTransport(t);
            setRates(t.availableRates());
            setStatus({ kind: "ready" });
          },
          onStateChange: (e: { data: number }) => {
            transportRef.current?.handleStateChange(e.data);
          },
          onPlaybackRateChange: () => {
            transportRef.current?.handleRateChange();
            if (transportRef.current) setRates(transportRef.current.availableRates());
          },
          onError: (e: { data: number }) => {
            setStatus({ kind: "error", ...youtubeErrorMessage(e.data) });
          },
        },
      });

      playerRef.current = player;
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [videoId, startSeconds]);

  useEffect(() => {
    void mount();
    return () => {
      transportRef.current?.destroy();
      transportRef.current = null;
      try {
        playerRef.current?.destroy();
      } catch {
        /* the iframe may already be gone */
      }
      playerRef.current = null;
    };
  }, [mount]);

  return { hostRef, status, transport, rates };
}
