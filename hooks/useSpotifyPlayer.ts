"use client";

/**
 * Loads the Web Playback SDK, creates a player, and hands back a SpotifyTransport.
 *
 * Failure modes worth handling explicitly, because each one looks like "it's broken"
 * to the user and each has a different fix:
 *
 *   account_error   → not Premium. The single most common cause. Say so.
 *   auth_error      → token bad or scopes missing (`streaming` especially).
 *   playback_error  → usually DRM: Widevine missing or blocked. Brave and hardened
 *                     Firefox profiles do this. So do privacy extensions.
 *   not_ready       → playback moved to another device.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getValidAccessToken } from "../lib/spotify-auth";
import { SpotifyTransport } from "../lib/transports/spotify-transport";

const SDK_URL = "https://sdk.scdn.co/spotify-player.js";

export type PlayerStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; deviceId: string }
  | { kind: "error"; message: string; hint?: string };

declare global {
  interface Window {
    Spotify?: { Player: new (opts: Record<string, unknown>) => never };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    if (window.Spotify) return resolve();
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () =>
      reject(
        new Error(
          "Could not load the Spotify Web Playback SDK. An ad or tracker blocker " +
            "will usually be the cause.",
        ),
      );
    document.body.appendChild(script);
  });
  return sdkPromise;
}

export function useSpotifyPlayer(options: { name?: string } = {}) {
  const [status, setStatus] = useState<PlayerStatus>({ kind: "idle" });
  const [transport, setTransport] = useState<SpotifyTransport | null>(null);
  const playerRef = useRef<never>(null);

  const connect = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      await loadSdk();

      const player = new window.Spotify!.Player({
        name: options.name ?? "Jammer",
        volume: 0.8,
        getOAuthToken: (cb: (token: string) => void) => {
          // Called again whenever the token expires — always resolve fresh.
          void getValidAccessToken().then((t) => t && cb(t));
        },
      }) as never as {
        addListener(e: string, cb: (p: never) => void): boolean;
        connect(): Promise<boolean>;
        disconnect(): void;
      };

      playerRef.current = player as never;

      player.addListener("initialization_error", ((e: { message: string }) => {
        setStatus({
          kind: "error",
          message: e.message,
          hint: "Your browser may not support Encrypted Media Extensions.",
        });
      }) as never);

      player.addListener("authentication_error", ((e: { message: string }) => {
        setStatus({
          kind: "error",
          message: e.message,
          hint: "Sign in again. Check the `streaming` scope was granted.",
        });
      }) as never);

      player.addListener("account_error", ((e: { message: string }) => {
        setStatus({
          kind: "error",
          message: e.message,
          hint:
            "The Web Playback SDK requires Spotify Premium. On a free account " +
            "search and library work, but nothing will play. Try local-file mode.",
        });
      }) as never);

      player.addListener("playback_error", ((e: { message: string }) => {
        setStatus({
          kind: "error",
          message: e.message,
          hint:
            "Usually DRM: Widevine is missing, blocked, or disabled. Privacy-hardened " +
            "browser profiles and some extensions cause this.",
        });
      }) as never);

      player.addListener("ready", (({ device_id }: { device_id: string }) => {
        setStatus({ kind: "ready", deviceId: device_id });
        setTransport(
          new SpotifyTransport(player as never, device_id),
        );
      }) as never);

      player.addListener("not_ready", (() => {
        setStatus({
          kind: "error",
          message: "Playback moved to another device.",
          hint: "Press play in Jammer to bring it back to this browser.",
        });
      }) as never);

      const ok = await player.connect();
      if (!ok) {
        setStatus({
          kind: "error",
          message: "The player failed to connect.",
        });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [options.name]);

  useEffect(() => {
    return () => {
      transport?.destroy();
      (playerRef.current as never as { disconnect?(): void } | null)?.disconnect?.();
    };
  }, [transport]);

  return { status, transport, connect };
}
