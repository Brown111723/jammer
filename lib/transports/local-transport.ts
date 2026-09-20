/**
 * Local file transport — an `<audio>` element.
 *
 * Start here when developing. No auth, no Premium, no network. More importantly this is
 * the **only** transport where `canAnalyzeAudio` is true: the file is the user's own, so
 * we can decode it, send it to the analyzer, and produce a chart.
 *
 * It also supports playback rate, which Spotify does not — slow-down practice lives here.
 */

import { now } from "../clock.ts";
import type {
  Transport,
  TransportCapabilities,
  TransportState,
} from "../transport";

export class LocalTransport implements Transport {
  readonly name = "local" as const;

  readonly capabilities: TransportCapabilities = {
    canChangeRate: true,
    canSeek: true,
    needsVisiblePlayer: false,
    canAnalyzeAudio: true,
    // `timeupdate` only fires ~4x/sec, so poll a little faster than that.
    pollIntervalMs: 100,
  };

  private subscribers = new Set<(s: TransportState) => void>();
  private cleanups: (() => void)[] = [];

  private audio: HTMLAudioElement;

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
    const emit = () => {
      const s = this.snapshot();
      for (const cb of this.subscribers) cb(s);
    };

    for (const event of [
      "play",
      "pause",
      "seeked",
      "ratechange",
      "loadedmetadata",
      "ended",
    ]) {
      audio.addEventListener(event, emit);
      this.cleanups.push(() => audio.removeEventListener(event, emit));
    }
  }

  private snapshot(): TransportState {
    return {
      positionMs: this.audio.currentTime * 1000,
      // An <audio> element's currentTime is accurate as of right now — no staleness to
      // correct for, unlike a remote transport.
      atWallMs: now(),
      playing: !this.audio.paused && !this.audio.ended,
      durationMs: Number.isFinite(this.audio.duration)
        ? this.audio.duration * 1000
        : 0,
      rate: this.audio.playbackRate,
    };
  }

  async getState(): Promise<TransportState | null> {
    return this.snapshot();
  }

  async play(): Promise<void> {
    await this.audio.play();
  }

  async pause(): Promise<void> {
    this.audio.pause();
  }

  async seek(positionMs: number): Promise<void> {
    this.audio.currentTime = Math.max(0, positionMs / 1000);
  }

  async setRate(rate: number): Promise<void> {
    this.audio.playbackRate = rate;
  }

  async setVolume(volume01: number): Promise<void> {
    this.audio.volume = Math.max(0, Math.min(1, volume01));
  }

  getVolume(): number {
    return this.audio.volume;
  }

  onStateChange(cb: (s: TransportState) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  destroy(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.subscribers.clear();
  }
}
