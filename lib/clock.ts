/**
 * PlaybackClock — a drift-corrected local clock disciplined by a remote transport.
 *
 * THE PROBLEM
 * -----------
 * Spotify's Web Playback SDK reports position via `getCurrentState()`. That value is:
 *
 *   - coarse    — it advances in steps, not continuously
 *   - stale     — it describes the moment the state was produced, not now
 *   - jittery   — worker scheduling and IPC add variable delay
 *   - expensive — it's an async round-trip; you cannot call it at 60 fps
 *
 * Driving a cursor directly from it produces a stuttering, lurching playhead. YouTube's
 * `getCurrentTime()` is better but has the same character.
 *
 * THE FIX
 * -------
 * Don't use the transport as a clock. Use it as a *reference* for a local clock, the way
 * NTP disciplines a system clock or a PLL locks an oscillator.
 *
 *   predicted(t) = anchorMedia + (t - anchorWall) * rate
 *
 * Each observation yields an error against the prediction. Then:
 *
 *   |error| >  HARD_SNAP  -> something discontinuous happened (seek, track change,
 *                           buffer stall). Re-anchor immediately.
 *   |error| <= HARD_SNAP  -> ordinary drift. DO NOT JUMP. Trim `rate` by a bounded
 *                           amount so the error closes smoothly over LOCK_HORIZON.
 *
 * A 2% rate trim is imperceptible. A 40ms cursor jump is extremely perceptible. That
 * asymmetry is the whole design.
 *
 * OFFSETS
 * -------
 * Two corrections sit between the clock and the cursor:
 *
 *   outputLatencyMs - how far behind the audio is from the media position. Bluetooth
 *                     headphones: 150-300ms. User-calibrated. Non-negotiable for a
 *                     jamming tool; without it players blame their own timing.
 *
 *   chartOffsetMs   - how this recording aligns to the chart. Derived from sync points.
 *                     Handles remasters, radio edits, live versions.
 *
 * Read `positionForDisplay()` on requestAnimationFrame. Feed `observe()` whatever the
 * transport gives you, whenever it gives it.
 */

export interface ClockObservation {
  /** Position reported by the transport, in ms. */
  positionMs: number;
  /**
   * When that position was *true*, as a `performance.now()`-domain timestamp.
   * Spotify's state carries an epoch `timestamp`; convert it with `epochToWall()`.
   * If you genuinely don't know, omit it and we assume "now" (slightly pessimistic).
   */
  atWallMs?: number;
  /** Whether the transport is playing. */
  playing: boolean;
  /** Transport playback rate, if it supports changing it. Spotify does not. */
  rate?: number;
}

export interface ClockOptions {
  /** Above this error (ms) we assume a discontinuity and re-anchor hard. */
  hardSnapMs?: number;
  /** Time (ms) over which a small error should be smoothly absorbed. */
  lockHorizonMs?: number;
  /** Maximum fractional rate trim, e.g. 0.02 = +/-2%. */
  maxRateTrim?: number;
  /** Ignore observations closer together than this (ms). */
  minObservationGapMs?: number;
}

const DEFAULTS: Required<ClockOptions> = {
  hardSnapMs: 250,
  lockHorizonMs: 1500,
  maxRateTrim: 0.02,
  minObservationGapMs: 30,
};

export class PlaybackClock {
  private opts: Required<ClockOptions>;

  /** Anchor: media position (ms) at a known wall time. */
  private anchorMedia = 0;
  private anchorWall = 0;

  /** Nominal transport rate (1 = normal). Spotify is always 1; YouTube can vary. */
  private nominalRate = 1;
  /** Effective rate including PLL trim. */
  private rate = 1;

  private playing = false;
  private lastObservationWall = -Infinity;

  /** Rolling drift estimate, for diagnostics and lock quality. */
  private lastErrorMs = 0;
  private errorEma = 0;
  private observations = 0;

  /** User-calibrated output latency (ms). Positive = audio lags the media position. */
  outputLatencyMs = 0;
  /** Chart-to-recording alignment (ms). Positive = chart is ahead of the recording. */
  chartOffsetMs = 0;

  constructor(options: ClockOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.anchorWall = now();
  }

  // ---------------------------------------------------------------- reading

  /** Raw predicted media position in ms, before any offsets. */
  positionMs(at = now()): number {
    if (!this.playing) return this.anchorMedia;
    return this.anchorMedia + (at - this.anchorWall) * this.rate;
  }

  /**
   * Position to draw the cursor at. This is what the UI and alphaTab should consume.
   * Call it from requestAnimationFrame.
   */
  positionForDisplay(at = now()): number {
    return Math.max(
      0,
      this.positionMs(at) - this.outputLatencyMs - this.chartOffsetMs,
    );
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get effectiveRate(): number {
    return this.rate;
  }

  /**
   * How well locked we are, 0..1. Below ~0.5 the transport is being unreliable —
   * worth surfacing in the UI as a subtle indicator rather than letting the user
   * wonder why the cursor feels vague.
   */
  get lockQuality(): number {
    if (this.observations < 3) return 0;
    return Math.max(0, 1 - Math.abs(this.errorEma) / this.opts.hardSnapMs);
  }

  get diagnostics() {
    return {
      lastErrorMs: this.lastErrorMs,
      errorEmaMs: this.errorEma,
      rate: this.rate,
      nominalRate: this.nominalRate,
      lockQuality: this.lockQuality,
      observations: this.observations,
      outputLatencyMs: this.outputLatencyMs,
      chartOffsetMs: this.chartOffsetMs,
    };
  }

  // ---------------------------------------------------------------- writing

  /** Feed the clock a transport report. Safe to call at any irregular cadence. */
  observe(obs: ClockObservation): void {
    const wall = obs.atWallMs ?? now();

    // A rate change is a discontinuity in the prediction, not a drift error.
    if (obs.rate !== undefined && obs.rate !== this.nominalRate) {
      this.nominalRate = obs.rate;
      this.playing = obs.playing;
      this.hardAnchor(obs.positionMs, wall);
      return;
    }

    // Play/pause transitions are discontinuities by definition.
    if (obs.playing !== this.playing) {
      this.playing = obs.playing;
      this.hardAnchor(obs.positionMs, wall);
      return;
    }

    if (!this.playing) {
      // Paused: track scrubbing exactly, no prediction to do.
      this.anchorMedia = obs.positionMs;
      this.anchorWall = wall;
      return;
    }

    // Rate-limit: very closely spaced reports add noise, not information.
    if (wall - this.lastObservationWall < this.opts.minObservationGapMs) return;
    this.lastObservationWall = wall;

    const predicted = this.positionMs(wall);
    const error = obs.positionMs - predicted;

    this.lastErrorMs = error;
    this.errorEma =
      this.observations === 0 ? error : this.errorEma * 0.8 + error * 0.2;
    this.observations++;

    if (Math.abs(error) > this.opts.hardSnapMs) {
      // Seek, track change, or a stall. Nothing to smooth — jump.
      this.hardAnchor(obs.positionMs, wall);
      return;
    }

    // Soft correction.
    //
    // Subtlety worth the two extra lines: the observation describes a moment in the
    // *past* (`wall`), but the new rate must take effect from *now*. If we re-anchor at
    // `wall` and then change the rate, the rate change applies retroactively across the
    // staleness window — with 80ms of staleness and a 2% trim that's a ~2ms cursor jump,
    // which is visible as a tick at 60fps.
    //
    // So: measure the error at `wall`, but re-anchor at the present using the OLD rate,
    // then apply the new rate going forward. Position is continuous by construction.
    const present = now();
    this.anchorMedia = this.positionMs(present);
    this.anchorWall = present;

    const trim = error / this.opts.lockHorizonMs;
    const clamped = Math.max(
      -this.opts.maxRateTrim,
      Math.min(this.opts.maxRateTrim, trim),
    );
    this.rate = this.nominalRate * (1 + clamped);
  }

  /** Force the clock to a position — use for local seeks you initiated yourself. */
  seek(positionMs: number, at = now()): void {
    this.hardAnchor(positionMs, at);
  }

  setPlaying(playing: boolean, positionMs?: number, at = now()): void {
    const pos = positionMs ?? this.positionMs(at);
    this.playing = playing;
    this.hardAnchor(pos, at);
  }

  reset(): void {
    this.anchorMedia = 0;
    this.anchorWall = now();
    this.nominalRate = 1;
    this.rate = 1;
    this.playing = false;
    this.lastObservationWall = -Infinity;
    this.errorEma = 0;
    this.lastErrorMs = 0;
    this.observations = 0;
  }

  private hardAnchor(positionMs: number, wall: number): void {
    this.anchorMedia = positionMs;
    this.anchorWall = wall;
    this.rate = this.nominalRate;
    this.errorEma = 0;
    this.lastErrorMs = 0;
  }
}

/** Monotonic wall clock, SSR-safe. */
export function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Spotify's WebPlaybackState carries `timestamp` as epoch ms. `performance.now()` is a
 * different domain, so convert before handing it to the clock:
 * `performance.timeOrigin + performance.now() === Date.now()` (modulo drift).
 */
export function epochToWall(epochMs: number): number {
  if (typeof performance === "undefined" || !performance.timeOrigin) {
    return epochMs;
  }
  return epochMs - performance.timeOrigin;
}
