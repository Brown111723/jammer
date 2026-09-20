/**
 * The Transport interface.
 *
 * Every playback source — Spotify, YouTube, a local file — implements this. Nothing
 * above this line knows which one is in use.
 *
 * Note what is *absent*: there is no `getAudioBuffer()`, no `getAnalyserNode()`, no way
 * to reach samples. That is deliberate and it is not an oversight we might fix later.
 * Spotify and YouTube deliver audio through Encrypted Media Extensions; the decrypted
 * samples never enter the JavaScript context. A transport's entire job is to answer
 * "where are you?" and to accept play/pause/seek.
 *
 * Audio analysis happens server-side, ahead of time, on files the user supplies.
 */

export interface TransportState {
  positionMs: number;
  /** `performance.now()`-domain timestamp for when positionMs was true. */
  atWallMs?: number;
  playing: boolean;
  durationMs: number;
  rate: number;
  trackId?: string;
}

export interface TransportCapabilities {
  /** Can playback speed be changed? Spotify: no. YouTube and local: yes. */
  canChangeRate: boolean;
  /** Can we seek to an arbitrary position? */
  canSeek: boolean;
  /** Does this transport need a visible player element? YouTube: yes, by ToS. */
  needsVisiblePlayer: boolean;
  /** Can we analyse the audio? Only true for local files. */
  canAnalyzeAudio: boolean;
  /** Minimum sensible polling interval in ms. */
  pollIntervalMs: number;
}

export interface Transport {
  readonly name: "spotify" | "youtube" | "local";
  readonly capabilities: TransportCapabilities;

  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  setVolume(volume01: number): Promise<void>;
  getVolume(): number;

  /** Current state, or null if nothing is loaded. */
  getState(): Promise<TransportState | null>;

  /**
   * Subscribe to state changes the transport pushes on its own. Most transports also
   * need polling; the driver in `sync-engine.ts` handles that.
   */
  onStateChange(cb: (state: TransportState) => void): () => void;

  destroy(): void;
}
