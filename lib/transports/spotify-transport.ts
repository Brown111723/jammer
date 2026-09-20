/**
 * Spotify transport, backed by the Web Playback SDK.
 *
 * The SDK creates a Spotify Connect device in the browser. Audio is decrypted by
 * Widevine inside the EME pipeline and never reaches JavaScript — so this transport
 * reports position and accepts commands, and that is all it can ever do.
 *
 * `player_state_changed` fires on transitions but not continuously, so the SyncEngine
 * also polls `getCurrentState()`. Both paths feed the same clock.
 *
 * The `timestamp` in WebPlaybackState is epoch ms and describes when the state was
 * produced — convert it with `epochToWall()` so the clock can subtract the staleness
 * instead of baking it in as a permanent offset.
 */

import { epochToWall } from "../clock.ts";
import type {
  Transport,
  TransportCapabilities,
  TransportState,
} from "../transport";

interface WebPlaybackState {
  paused: boolean;
  position: number;
  duration: number;
  timestamp: number;
  track_window: { current_track: { id: string | null; uri: string } | null };
}

interface SpotifyPlayerInstance {
  connect(): Promise<boolean>;
  disconnect(): void;
  getCurrentState(): Promise<WebPlaybackState | null>;
  getVolume(): Promise<number>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  addListener(event: string, cb: (payload: never) => void): boolean;
  removeListener(event: string): boolean;
}

export class SpotifyTransport implements Transport {
  readonly name = "spotify" as const;

  readonly capabilities: TransportCapabilities = {
    // Spotify has no playback-rate control at all. This is the single biggest
    // functional argument for supporting local files and YouTube: slow-down practice
    // is the feature guitarists ask for first, and Spotify cannot do it.
    canChangeRate: false,
    canSeek: true,
    needsVisiblePlayer: false,
    canAnalyzeAudio: false,
    pollIntervalMs: 200,
  };

  private subscribers = new Set<(s: TransportState) => void>();
  private volume = 1;
  private lastKnownDuration = 0;

  private player: SpotifyPlayerInstance;
  readonly deviceId: string;

  constructor(player: SpotifyPlayerInstance, deviceId: string) {
    this.player = player;
    this.deviceId = deviceId;
    this.player.addListener("player_state_changed", ((state: WebPlaybackState | null) => {
      if (!state) return;
      const mapped = this.mapState(state);
      for (const cb of this.subscribers) cb(mapped);
    }) as never);

    void this.player.getVolume().then((v) => {
      this.volume = v;
    });
  }

  private mapState(state: WebPlaybackState): TransportState {
    this.lastKnownDuration = state.duration || this.lastKnownDuration;
    return {
      positionMs: state.position,
      atWallMs: epochToWall(state.timestamp),
      playing: !state.paused,
      durationMs: state.duration,
      rate: 1,
      trackId: state.track_window?.current_track?.id ?? undefined,
    };
  }

  async getState(): Promise<TransportState | null> {
    const state = await this.player.getCurrentState();
    // null means playback has moved to another device — the user pressed play on their
    // phone. Surface that in the UI rather than silently freezing the cursor.
    if (!state) return null;
    return this.mapState(state);
  }

  async play(): Promise<void> {
    await this.player.resume();
  }

  async pause(): Promise<void> {
    await this.player.pause();
  }

  async seek(positionMs: number): Promise<void> {
    await this.player.seek(Math.max(0, Math.round(positionMs)));
  }

  async setRate(): Promise<void> {
    // No-op rather than throw: alphaTab may set this during init, and a thrown error
    // there is harder to diagnose than a quietly ignored call.
  }

  async setVolume(volume01: number): Promise<void> {
    this.volume = Math.max(0, Math.min(1, volume01));
    await this.player.setVolume(this.volume);
  }

  getVolume(): number {
    return this.volume;
  }

  onStateChange(cb: (s: TransportState) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  destroy(): void {
    this.subscribers.clear();
    this.player.removeListener("player_state_changed");
  }
}
