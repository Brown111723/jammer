/**
 * YouTube transport, backed by the IFrame Player API.
 *
 * WHY THIS IS THE BETTER TRANSPORT FOR JAMMING
 * --------------------------------------------
 * Spotify's Web Playback SDK has no playback-rate control at all. YouTube's has
 * `setPlaybackRate`, typically offering 0.25×–2×. Practising a solo at 70% speed is the
 * single feature guitarists ask for first, and only this transport can do it.
 *
 * It's also free — no Premium requirement — and the catalogue is far larger: live
 * versions, acoustic sessions, covers, the lot.
 *
 * WHAT IT STILL CAN'T DO
 * ----------------------
 * The audio is DRM-protected and lives in a cross-origin iframe, so it is no more
 * analysable than Spotify's. Transcription still needs a local file.
 *
 * TWO QUIRKS THAT WILL BITE
 * -------------------------
 * 1. `seekTo` starts playback. From the docs: "If the player is paused when the
 *    function is called, it will remain paused. If the function is called from another
 *    state (playing, video cued, etc.), the player will play the video." A cued video
 *    is not paused, so any seek before the user has pressed play will start the video
 *    unbidden. We defer such seeks until the first real play.
 *
 * 2. `getCurrentTime()` is a synchronous cross-frame read and it is coarse — it
 *    typically advances in ~250ms steps rather than continuously. Exactly the kind of
 *    reference the PlaybackClock is built to smooth, so we report it honestly and let
 *    the clock do its job.
 */

import { now } from "../clock.ts";
import type {
  Transport,
  TransportCapabilities,
  TransportState,
} from "../transport";

/** The slice of the YT player we use. Typed structurally so no global types are needed. */
export interface YouTubePlayerInstance {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVolume(): number;
  setVolume(volume: number): void;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  loadVideoById(videoId: string, startSeconds?: number): void;
  destroy(): void;
}

/** YT.PlayerState values, inlined so we don't depend on the global being loaded. */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export class YouTubeTransport implements Transport {
  readonly name = "youtube" as const;

  readonly capabilities: TransportCapabilities = {
    // The reason to prefer YouTube over Spotify for practice.
    canChangeRate: true,
    canSeek: true,
    // YouTube's terms require the player be visible and at least 200x200.
    needsVisiblePlayer: true,
    // Cross-origin iframe + DRM. Same wall as Spotify.
    canAnalyzeAudio: false,
    // getCurrentTime is cheap (no network), so poll a bit faster than Spotify.
    pollIntervalMs: 100,
  };

  private player: YouTubePlayerInstance;
  private subscribers = new Set<(s: TransportState) => void>();

  /** A seek requested before playback started, deferred to avoid auto-starting. */
  private pendingSeekSec = -1;
  private hasPlayed = false;
  readonly videoId: string;

  constructor(player: YouTubePlayerInstance, videoId: string) {
    this.player = player;
    this.videoId = videoId;
  }

  /** Called by the hook from the player's own onStateChange event. */
  handleStateChange(state: number): void {
    if (state === YT_STATE.PLAYING) {
      this.hasPlayed = true;
      // Apply any seek we held back while the video was merely cued.
      if (this.pendingSeekSec >= 0) {
        this.player.seekTo(this.pendingSeekSec, true);
        this.pendingSeekSec = -1;
      }
    }
    const snapshot = this.snapshot();
    for (const cb of this.subscribers) cb(snapshot);
  }

  handleRateChange(): void {
    const snapshot = this.snapshot();
    for (const cb of this.subscribers) cb(snapshot);
  }

  private snapshot(): TransportState {
    // Annotated: YT_STATE is `as const`, so inference would narrow this to the
    // literal -1 and then reject every comparison below.
    let state: number = YT_STATE.UNSTARTED;
    let position = 0;
    let duration = 0;
    let rate = 1;

    try {
      state = this.player.getPlayerState();
      position = this.player.getCurrentTime() * 1000;
      duration = this.player.getDuration() * 1000;
      rate = this.player.getPlaybackRate();
    } catch {
      // The iframe can be mid-teardown; a stale snapshot is better than throwing
      // inside the poll loop.
    }

    return {
      positionMs: position,
      // getCurrentTime() reflects the moment we ask, so there's no staleness to
      // correct for — unlike Spotify, whose state carries its own timestamp.
      atWallMs: now(),
      // BUFFERING counts as playing: the playhead is logically still running and
      // treating a buffer stall as a pause makes the cursor stutter.
      playing: state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING,
      durationMs: duration,
      rate,
      trackId: this.videoId,
    };
  }

  async getState(): Promise<TransportState | null> {
    return this.snapshot();
  }

  async play(): Promise<void> {
    this.player.playVideo();
  }

  async pause(): Promise<void> {
    this.player.pauseVideo();
  }

  async seek(positionMs: number): Promise<void> {
    const seconds = Math.max(0, positionMs / 1000);

    // Quirk 1: seeking a cued (not yet played) video starts it. Hold the seek until
    // the user actually presses play.
    if (!this.hasPlayed) {
      const state = safeState(this.player);
      if (state !== YT_STATE.PLAYING && state !== YT_STATE.PAUSED) {
        this.pendingSeekSec = seconds;
        return;
      }
    }

    this.player.seekTo(seconds, true);
  }

  async setRate(rate: number): Promise<void> {
    // setPlaybackRate silently ignores unsupported values, so snap to the nearest
    // rate the video actually offers. Otherwise the UI shows 0.7x while the audio
    // plays at 1x and the cursor drifts against it.
    const available = this.availableRates();
    const nearest = available.reduce((best, r) =>
      Math.abs(r - rate) < Math.abs(best - rate) ? r : best,
    );
    this.player.setPlaybackRate(nearest);
  }

  availableRates(): number[] {
    try {
      const rates = this.player.getAvailablePlaybackRates();
      return rates?.length ? rates : [1];
    } catch {
      return [1];
    }
  }

  async setVolume(volume01: number): Promise<void> {
    this.player.setVolume(Math.round(Math.max(0, Math.min(1, volume01)) * 100));
  }

  getVolume(): number {
    try {
      return this.player.getVolume() / 100;
    } catch {
      return 1;
    }
  }

  onStateChange(cb: (s: TransportState) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  destroy(): void {
    this.subscribers.clear();
  }
}

function safeState(player: YouTubePlayerInstance): number {
  try {
    return player.getPlayerState();
  } catch {
    return YT_STATE.UNSTARTED;
  }
}

/** YouTube's onError codes, translated into something a user can act on. */
export function youtubeErrorMessage(code: number): { message: string; hint?: string } {
  switch (code) {
    case 2:
      return { message: "That video ID isn't valid." };
    case 5:
      return {
        message: "The video can't be played in the HTML5 player.",
        hint: "Rare these days — usually means the video is broken or region-locked.",
      };
    case 100:
      return {
        message: "That video doesn't exist, or it's private.",
        hint: "Check the link, or search for another upload of the track.",
      };
    case 101:
    case 150:
      return {
        message: "The uploader has disabled embedding for this video.",
        hint:
          "Common for official music videos from major labels. Look for an " +
          "\"Artist - Topic\" upload — those are the YouTube Music audio tracks and " +
          "are almost always embeddable.",
      };
    case 153:
      return {
        message: "YouTube rejected the request (missing HTTP referrer).",
        hint: "This usually means the page was opened as a file:// URL.",
      };
    default:
      return { message: `YouTube player error ${code}.` };
  }
}
