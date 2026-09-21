/**
 * SyncEngine — binds a Transport to the PlaybackClock and to alphaTab.
 *
 * Three loops, deliberately at different rates:
 *
 *   1. POLL  (transport-dependent, ~200ms for Spotify)
 *      Ask the transport where it is. Feed the clock. Never touch the UI from here —
 *      these samples are noisy and arrive irregularly.
 *
 *   2. PUSH  (50ms)
 *      Hand alphaTab the clock's smoothed position. alphaTab's docs recommend a rate
 *      "smaller than two subsequent notes"; 50ms holds up on fast material.
 *
 *   3. RENDER (requestAnimationFrame)
 *      Anything we draw ourselves — a scrub bar, a lyric line, a chord readout — reads
 *      the clock directly. Never from React state; a 60fps position in React state will
 *      melt the render tree.
 *
 * Subscribers get the position via a callback invoked on rAF, and are expected to write
 * to DOM/refs rather than setState.
 */

import { PlaybackClock, epochToWall, now } from "./clock.ts";
import { loopWrapTarget, type LoopRegion } from "./loop.ts";
import type { Transport, TransportState } from "./transport";

/** The slice of alphaTab's API we use. Typed structurally so alphaTab stays optional. */
export interface ScoreTimeMap {
  /** Recording ms -> the notation file's own ms. */
  toScore(ms: number): number;
  /** The notation file's own ms -> recording ms. */
  fromScore(ms: number): number;
}

export interface AlphaTabExternalMediaHandler {
  readonly backingTrackDuration: number;
  playbackRate: number;
  masterVolume: number;
  seekTo(timeMs: number): void;
  play(): void;
  pause(): void;
}

export interface AlphaTabExternalMediaOutput {
  handler: AlphaTabExternalMediaHandler | null;
  updatePosition(timeMs: number): void;
}

export interface AlphaTabApiLike {
  player?: { output: unknown } | null;
  play(): boolean | void;
  pause(): void;
  stop(): void;
  playbackSpeed: number;
  masterVolume: number;
  destroy?(): void;
}

export interface SyncEngineOptions {
  /** How often to push position into alphaTab. alphaTab recommends <= 50ms. */
  pushIntervalMs?: number;
  /** Override the transport's suggested poll interval. */
  pollIntervalMs?: number;
}

export class SyncEngine {
  readonly clock: PlaybackClock;

  private transport: Transport | null = null;
  private alphaTab: AlphaTabApiLike | null = null;
  private output: AlphaTabExternalMediaOutput | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * alphaTab moves its cursor by ITS idea of time: the file's own tempo map. A real
   * recording drifts from that (different lead-in, a live feel, a slightly different
   * tempo), and the user's alignment captures the difference. This converts between
   * recording time and the file's time so the notation cursor follows the alignment,
   * not the file's metronome. Null = the two are the same.
   */
  private scoreTime: ScoreTimeMap | null = null;
  private rafHandle: number | null = null;
  private unsubscribeTransport: (() => void) | null = null;

  private frameSubscribers = new Set<(positionMs: number) => void>();
  private durationMs = 0;
  private opts: Required<SyncEngineOptions>;

  /** Set true while we are driving the transport from alphaTab, to avoid feedback. */
  private suppressHandler = false;

  /** Active loop region, or null. Checked on every frame. */
  private loop: LoopRegion | null = null;
  private lastWrapAt = -Infinity;
  private loopListeners = new Set<(region: LoopRegion | null) => void>();

  constructor(clock = new PlaybackClock(), options: SyncEngineOptions = {}) {
    this.clock = clock;
    this.opts = {
      pushIntervalMs: options.pushIntervalMs ?? 50,
      pollIntervalMs: options.pollIntervalMs ?? 200,
    };
  }

  // ---------------------------------------------------------------- wiring

  attachTransport(transport: Transport): void {
    this.detachTransport();
    this.transport = transport;

    const interval = Math.max(
      transport.capabilities.pollIntervalMs,
      this.opts.pollIntervalMs,
    );

    this.unsubscribeTransport = transport.onStateChange((state) => {
      this.ingest(state);
    });

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, interval);

    void this.poll();
    this.startFrameLoop();
  }

  detachTransport(): void {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.transport = null;
  }

  /**
   * Attach an alphaTab API instance that was created with
   * `settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia`.
   *
   * We install a handler so alphaTab's own transport controls drive the real transport,
   * and we start pushing position into it.
   */
  attachAlphaTab(api: AlphaTabApiLike): void {
    this.alphaTab = api;
    const output = api.player?.output as AlphaTabExternalMediaOutput | undefined;

    if (!output || typeof output.updatePosition !== "function") {
      throw new Error(
        "SyncEngine: alphaTab player output is not an external-media output. " +
          "Create the API with player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia.",
      );
    }
    this.output = output;

    const engine = this;
    output.handler = {
      get backingTrackDuration() {
        return engine.durationMs;
      },
      get playbackRate() {
        return engine.clock.effectiveRate;
      },
      set playbackRate(value: number) {
        if (engine.suppressHandler) return;
        void engine.transport?.setRate(value);
      },
      get masterVolume() {
        return engine.transport?.getVolume() ?? 1;
      },
      set masterVolume(value: number) {
        if (engine.suppressHandler) return;
        void engine.transport?.setVolume(value);
      },
      seekTo(timeMs: number) {
        if (engine.suppressHandler) return;
        // alphaTab asks in its own time; convert to recording time, then back through
        // the offsets the clock applies.
        const chartMs = engine.scoreTime ? engine.scoreTime.fromScore(timeMs) : timeMs;
        const mediaMs = chartMs + engine.clock.outputLatencyMs + engine.clock.chartOffsetMs;
        engine.clock.seek(mediaMs);
        void engine.transport?.seek(mediaMs);
      },
      play() {
        if (engine.suppressHandler) return;
        void engine.transport?.play();
      },
      pause() {
        if (engine.suppressHandler) return;
        void engine.transport?.pause();
      },
    };

    this.pushTimer = setInterval(() => {
      this.push();
    }, this.opts.pushIntervalMs);
  }

  setScoreTimeMap(map: ScoreTimeMap | null): void {
    this.scoreTime = map;
    this.push();
  }

  detachAlphaTab(): void {
    if (this.pushTimer !== null) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.output) this.output.handler = null;
    this.output = null;
    this.alphaTab = null;
  }

  // ---------------------------------------------------------------- loops

  private async poll(): Promise<void> {
    if (!this.transport) return;
    try {
      const state = await this.transport.getState();
      if (state) this.ingest(state);
    } catch {
      // A failed poll is normal — device moved, token refreshing, tab backgrounded.
      // The clock keeps free-running, which is exactly what we want in the gap.
    }
  }

  private ingest(state: TransportState): void {
    const wasPlaying = this.clock.isPlaying;
    this.durationMs = state.durationMs || this.durationMs;

    this.clock.observe({
      positionMs: state.positionMs,
      atWallMs: state.atWallMs,
      playing: state.playing,
      rate: state.rate,
    });

    // Mirror play/pause into alphaTab so its cursor animation starts and stops.
    if (this.alphaTab && wasPlaying !== state.playing) {
      this.suppressHandler = true;
      try {
        if (state.playing) this.alphaTab.play();
        else this.alphaTab.pause();
      } finally {
        this.suppressHandler = false;
      }
    }
  }

  private push(): void {
    if (!this.output) return;
    const pos = this.clock.positionForDisplay();
    this.output.updatePosition(this.scoreTime ? this.scoreTime.toScore(pos) : pos);
  }

  private startFrameLoop(): void {
    if (this.rafHandle !== null) return;
    if (typeof requestAnimationFrame === "undefined") return;

    const tick = () => {
      const pos = this.clock.positionForDisplay();

      // Loop wrapping is checked here, on the frame loop, rather than on the slower
      // transport poll: at 200ms poll intervals we could overshoot a loop end by a
      // fifth of a second, which is audible and lands you in the next section.
      if (this.loop?.enabled && this.clock.isPlaying) {
        const target = loopWrapTarget(this.loop, pos, now(), this.lastWrapAt);
        if (target !== null) {
          this.lastWrapAt = now();
          void this.seek(target);
        }
      }

      for (const cb of this.frameSubscribers) cb(pos);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /**
   * Subscribe to per-frame position. Write to refs/DOM in the callback — do NOT call
   * setState here.
   */
  onFrame(cb: (positionMs: number) => void): () => void {
    this.frameSubscribers.add(cb);
    this.startFrameLoop();
    return () => this.frameSubscribers.delete(cb);
  }

  // ---------------------------------------------------------------- control

  async play(): Promise<void> {
    await this.transport?.play();
  }

  async pause(): Promise<void> {
    await this.transport?.pause();
  }

  /** Seek in recording time. The clock jumps immediately so the cursor feels instant. */
  async seek(mediaMs: number): Promise<void> {
    this.clock.seek(mediaMs);
    await this.transport?.seek(mediaMs);
  }

  /** Re-export so callers don't need a second import for the loop types. */
  static readonly version = 1;

  get duration(): number {
    return this.durationMs;
  }

  // ---------------------------------------------------------------- looping

  get loopRegion(): LoopRegion | null {
    return this.loop;
  }

  setLoop(region: LoopRegion | null): void {
    this.loop = region;
    this.lastWrapAt = -Infinity;
    for (const cb of this.loopListeners) cb(region);

    // Jump into the region immediately if we're outside it — otherwise enabling a loop
    // appears to do nothing until playback happens to wander into range.
    if (region?.enabled) {
      const pos = this.clock.positionForDisplay();
      if (pos < region.startMs || pos > region.endMs) {
        void this.seek(region.startMs);
      }
    }
  }

  onLoopChange(cb: (region: LoopRegion | null) => void): () => void {
    this.loopListeners.add(cb);
    return () => this.loopListeners.delete(cb);
  }

  destroy(): void {
    this.detachAlphaTab();
    this.detachTransport();
    if (this.rafHandle !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafHandle);
    }
    this.rafHandle = null;
    this.frameSubscribers.clear();
  }
}

/** Re-exported so callers don't need to import from two places. */
export { PlaybackClock, epochToWall, now };
export type { LoopRegion };
