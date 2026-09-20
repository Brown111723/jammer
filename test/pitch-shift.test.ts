import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fft,
  timeStretch,
  resample,
  pitchShiftChannel,
} from "../lib/pitch-shift.ts";

const SR = 44100;

function sine(freq: number, seconds: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

/** Dominant frequency of a signal, via a windowed FFT of its middle. */
function dominantFrequency(signal: Float32Array, sampleRate = SR): number {
  const n = 8192;
  const start = Math.max(0, Math.floor(signal.length / 2) - n / 2);
  const re = new Float32Array(n);
  const im = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // Hann
    re[i] = (signal[start + i] ?? 0) * w;
  }
  fft(re, im, false);

  let peak = 0;
  let peakMag = -Infinity;
  // Ignore DC and the very lowest bins.
  for (let k = 2; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    if (mag > peakMag) {
      peakMag = mag;
      peak = k;
    }
  }
  return (peak * sampleRate) / n;
}

function rms(signal: Float32Array): number {
  let sum = 0;
  for (const s of signal) sum += s * s;
  return Math.sqrt(sum / signal.length);
}

test("FFT round-trips a signal", () => {
  const n = 1024;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const original = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    original[i] = Math.sin((2 * Math.PI * 5 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 17 * i) / n);
    re[i] = original[i];
  }

  fft(re, im, false);
  fft(re, im, true);

  for (let i = 0; i < n; i++) {
    assert.ok(
      Math.abs(re[i] - original[i]) < 1e-4,
      `sample ${i}: ${re[i]} vs ${original[i]}`,
    );
  }
});

test("FFT finds the right bin for a pure tone", () => {
  const n = 4096;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const binsPerHz = n / SR;
  const freq = 440;

  for (let i = 0; i < n; i++) {
    re[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  }
  fft(re, im, false);

  let peak = 0;
  let peakMag = -Infinity;
  for (let k = 1; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    if (mag > peakMag) {
      peakMag = mag;
      peak = k;
    }
  }
  assert.ok(
    Math.abs(peak - freq * binsPerHz) <= 1,
    `expected bin ~${(freq * binsPerHz).toFixed(1)}, got ${peak}`,
  );
});

test("FFT rejects non-power-of-two lengths rather than producing garbage", () => {
  assert.throws(() => fft(new Float32Array(1000), new Float32Array(1000)));
});

test("time stretch changes duration but not pitch", () => {
  const input = sine(440, 1.0);

  const longer = timeStretch(input, 1.5);
  assert.ok(
    Math.abs(longer.length / input.length - 1.5) < 0.05,
    `expected ~1.5x length, got ${(longer.length / input.length).toFixed(3)}`,
  );
  // The whole point: pitch must be untouched.
  const freq = dominantFrequency(longer);
  assert.ok(Math.abs(freq - 440) < 15, `pitch drifted to ${freq.toFixed(1)}Hz`);

  const shorter = timeStretch(input, 0.75);
  assert.ok(Math.abs(shorter.length / input.length - 0.75) < 0.05);
  assert.ok(Math.abs(dominantFrequency(shorter) - 440) < 15);
});

test("resampling shifts pitch and duration together", () => {
  const input = sine(440, 1.0);
  const up = resample(input, 2);

  assert.ok(Math.abs(up.length - input.length / 2) <= 2, "half the samples");
  const freq = dominantFrequency(up);
  assert.ok(Math.abs(freq - 880) < 20, `expected ~880Hz, got ${freq.toFixed(1)}`);
});

test("pitch shift by +12 semitones doubles the frequency, keeping duration", () => {
  const input = sine(220, 1.0);
  const out = pitchShiftChannel(input, 12);

  assert.ok(
    Math.abs(out.length - input.length) / input.length < 0.05,
    `duration changed: ${out.length} vs ${input.length}`,
  );

  const freq = dominantFrequency(out);
  assert.ok(Math.abs(freq - 440) < 20, `expected ~440Hz, got ${freq.toFixed(1)}`);
});

test("pitch shift by -12 semitones halves the frequency", () => {
  const input = sine(880, 1.0);
  const out = pitchShiftChannel(input, -12);

  assert.ok(Math.abs(out.length - input.length) / input.length < 0.05);
  const freq = dominantFrequency(out);
  assert.ok(Math.abs(freq - 440) < 20, `expected ~440Hz, got ${freq.toFixed(1)}`);
});

test("the common case: one semitone, the 'recorded in Eb' fix", () => {
  // E (329.63) up a semitone should land on F (349.23).
  const input = sine(329.63, 1.0);
  const out = pitchShiftChannel(input, 1);

  const freq = dominantFrequency(out);
  assert.ok(
    Math.abs(freq - 349.23) < 12,
    `expected ~349Hz (F), got ${freq.toFixed(1)}`,
  );
  assert.ok(Math.abs(out.length - input.length) / input.length < 0.05);
});

test("shifting by zero is a pass-through, not a re-render", () => {
  const input = sine(440, 0.2);
  const out = pitchShiftChannel(input, 0);
  assert.equal(out.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assert.equal(out[i], input[i]);
  }
});

test("output stays at a sane level — no runaway gain or collapse", () => {
  const input = sine(440, 1.0);
  for (const semitones of [-5, -2, 1, 3, 7]) {
    const out = pitchShiftChannel(input, semitones);
    const ratio = rms(out) / rms(input);
    assert.ok(
      ratio > 0.3 && ratio < 2.2,
      `${semitones} semitones changed RMS by ${ratio.toFixed(2)}x`,
    );
  }
});

test("a chord survives shifting — all partials move together", () => {
  // A major triad: A3, C#4, E4.
  const freqs = [220, 277.18, 329.63];
  const input = new Float32Array(SR);
  for (let i = 0; i < input.length; i++) {
    let s = 0;
    for (const f of freqs) s += Math.sin((2 * Math.PI * f * i) / SR) / freqs.length;
    input[i] = s;
  }

  const out = pitchShiftChannel(input, 2);
  // The lowest partial should land a whole tone up: 220 -> 246.94.
  const freq = dominantFrequency(out);
  const expected = freqs.map((f) => f * Math.pow(2, 2 / 12));
  assert.ok(
    expected.some((e) => Math.abs(freq - e) < 12),
    `dominant ${freq.toFixed(1)}Hz matched none of ${expected.map((e) => e.toFixed(1))}`,
  );
});
