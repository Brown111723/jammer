/**
 * Pitch shifting without changing tempo — a phase vocoder.
 *
 * WHERE THIS CAN AND CANNOT BE USED
 * ---------------------------------
 * Only on local files. Spotify and YouTube audio is decrypted inside the EME/Widevine
 * pipeline and the samples never enter the JavaScript context, so there is nothing to
 * process. That is the same wall that makes live transcription impossible, and it is
 * not something to route around.
 *
 * For streamed audio the answer to "play this in a different key" is the *fingering*
 * transform in `transpose.ts`: retune or capo the chart so you play different shapes
 * that sound right against the unmodified recording. For a lot of real cases — most
 * rock recorded a half step down — that is actually the better answer anyway, because
 * nothing gets degraded by resampling.
 *
 * HOW IT WORKS
 * ------------
 * Pitch shifting by a ratio r, with tempo unchanged, is two operations:
 *
 *   1. Time-stretch by r      (same pitch, different duration)
 *   2. Resample by 1/r        (restores duration, shifts pitch by r)
 *
 * Step 1 is the hard one. Naive overlap-add produces phasiness and transient smearing
 * because adjacent windows disagree about phase. A phase vocoder fixes that by working
 * in the frequency domain: for each bin it measures the *actual* frequency from the
 * phase advance between frames, then re-accumulates phase at the new hop size so
 * partials stay coherent.
 *
 * This runs offline over the whole decoded buffer rather than in real time. A few
 * seconds of processing for a clean result beats an AudioWorklet fighting a deadline,
 * and the result is cached per semitone so switching back is instant.
 *
 * KNOWN LIMITS, stated honestly:
 *  - Transients (drum hits, picked attacks) soften slightly. Inherent to the method;
 *    transient-preserving variants exist and are much more complex.
 *  - Beyond about ±5 semitones it starts sounding processed. ±2 is transparent enough
 *    that most people won't notice, which covers the common "recorded in Eb" case.
 */

/** In-place iterative radix-2 FFT. `re` and `im` must be a power-of-two length. */
export function fft(re: Float32Array, im: Float32Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error("FFT length must be a power of two");

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (2 * Math.PI) / len / (inverse ? -1 : 1);
    const wRe = Math.cos(angle);
    const wIm = -Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;

        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

const FRAME_SIZE = 2048;
const OVERSAMPLING = 4; // analysis hop = FRAME_SIZE / OVERSAMPLING

/**
 * Time-stretch one channel by `ratio` (>1 = longer) using a phase vocoder.
 * Pitch is unchanged.
 */
export function timeStretch(input: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-6) return input.slice();

  const frame = FRAME_SIZE;
  const half = frame / 2;

  // Fix the SYNTHESIS hop and derive the analysis hop, rather than the reverse.
  //
  // The intuitive formulation — fixed analysis hop, synthesis hop scaled by the ratio —
  // means the synthesis overlap changes with the ratio. At ratio 2 it drops to 50%,
  // where Hann-squared no longer sums flat and any residual phase error turns into
  // destructive interference. Measured: the middle of a stretched sine lost ~9dB.
  //
  // Pinning the synthesis side at 75% overlap keeps overlap-add in its well-conditioned
  // regime for every ratio, and moves the variation to the analysis side where it only
  // affects how often we sample the input.
  const synthesisHop = Math.round(frame / OVERSAMPLING);
  const analysisHop = Math.max(1, Math.round(synthesisHop / ratio));

  const outLength = Math.ceil(input.length * ratio) + frame;
  const output = new Float32Array(outLength);
  const windowSum = new Float32Array(outLength);

  // Hann window, applied on both analysis and synthesis. With OLA at 75% overlap this
  // sums to a constant, so dividing by the accumulated window removes ripple.
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  }

  const lastPhase = new Float32Array(half + 1);
  const sumPhase = new Float32Array(half + 1);
  const expectedPhaseAdvance = (2 * Math.PI * analysisHop) / frame;

  const re = new Float32Array(frame);
  const im = new Float32Array(frame);
  const magnitude = new Float32Array(half + 1);
  const phase = new Float32Array(half + 1);

  let outPos = 0;
  for (let pos = 0; pos + frame <= input.length; pos += analysisHop) {
    for (let i = 0; i < frame; i++) {
      re[i] = input[pos + i] * win[i];
      im[i] = 0;
    }

    fft(re, im, false);

    for (let k = 0; k <= half; k++) {
      magnitude[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // Advance the phase of every bin independently — correct per bin, but see the
    // locking pass below for why that isn't sufficient on its own.
    for (let k = 0; k <= half; k++) {
      // Phase advance beyond what this bin's centre frequency predicts, wrapped to
      // (-pi, pi]. This is what tells us the partial's true frequency.
      let delta = phase[k] - lastPhase[k] - k * expectedPhaseAdvance;
      delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));

      const trueFreq = k * expectedPhaseAdvance + delta;
      sumPhase[k] += (trueFreq * synthesisHop) / analysisHop;
    }

    // IDENTITY PHASE LOCKING (Laroche & Dolson).
    //
    // A single sinusoid does not land in one bin — the analysis window smears it
    // across a small group. Advancing each of those bins independently lets their
    // phases drift apart, and on resynthesis they partially cancel. The tone stays at
    // the right frequency but loses amplitude, badly: measured at ratio 2, the middle
    // of a pure sine came out 18dB down while the detected pitch was still correct.
    //
    // The fix is to treat each spectral peak as one entity. Bins adjacent to a peak
    // inherit the peak's advanced phase, offset by the phase relationship they had in
    // the analysis frame. Relative phase within the group is preserved, so the group
    // adds constructively again.
    for (let k = 1; k < half; k++) {
      const isPeak =
        magnitude[k] > magnitude[k - 1] && magnitude[k] >= magnitude[k + 1];
      if (!isPeak) continue;

      // Lock the immediate neighbourhood of the peak to it.
      for (let j = k - 1; j <= k + 1; j += 2) {
        if (j < 0 || j > half) continue;
        // Only take over a bin that is part of this peak's skirt, not one that
        // belongs to a louder neighbour.
        if (magnitude[j] > magnitude[k]) continue;
        sumPhase[j] = sumPhase[k] + (phase[j] - phase[k]);
      }
    }

    for (let k = 0; k <= half; k++) {
      lastPhase[k] = phase[k];

      re[k] = magnitude[k] * Math.cos(sumPhase[k]);
      im[k] = magnitude[k] * Math.sin(sumPhase[k]);

      // Mirror for the negative frequencies.
      if (k > 0 && k < half) {
        re[frame - k] = re[k];
        im[frame - k] = -im[k];
      }
    }

    fft(re, im, true);

    for (let i = 0; i < frame; i++) {
      const target = outPos + i;
      if (target >= outLength) break;
      output[target] += re[i] * win[i];
      windowSum[target] += win[i] * win[i];
    }

    outPos += synthesisHop;
  }

  // Normalise by the accumulated window, but with a floor.
  //
  // At the very start and end only one or two frames overlap, so windowSum there is a
  // tiny fraction of its steady-state value. Dividing by it amplifies those samples
  // enormously — a guard of `> 1e-6` still permits a gain of 100,000x, which shows up
  // as a burst of noise at the end of every processed track. Measured: full-signal RMS
  // was 7.5x the input at +7 semitones while the middle was correct.
  //
  // Flooring at a fraction of the peak caps the gain and lets the edges fade out
  // naturally, since the raw sum is small there too.
  let peak = 0;
  for (let i = 0; i < outLength; i++) {
    if (windowSum[i] > peak) peak = windowSum[i];
  }
  const floor = Math.max(peak * 0.1, 1e-6);

  for (let i = 0; i < outLength; i++) {
    output[i] /= Math.max(windowSum[i], floor);
  }

  return output.subarray(0, Math.min(outLength, Math.ceil(input.length * ratio)));
}

/** Linear-interpolating resampler. `ratio` > 1 produces a shorter, higher-pitched result. */
export function resample(input: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-6) return input.slice();

  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const src = i * ratio;
    const idx = Math.floor(src);
    const frac = src - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }

  return output;
}

/** Shift one channel by `semitones`, preserving duration. */
export function pitchShiftChannel(
  input: Float32Array,
  semitones: number,
): Float32Array {
  if (semitones === 0) return input.slice();
  const ratio = Math.pow(2, semitones / 12);
  // Stretch by the ratio, then resample back — net effect is pitch only.
  return resample(timeStretch(input, ratio), ratio);
}

/**
 * Pitch-shift a decoded AudioBuffer.
 *
 * `onProgress` is called per channel, because on a long track this takes a couple of
 * seconds and a silent freeze reads as a crash.
 */
export async function pitchShiftBuffer(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  semitones: number,
  onProgress?: (fraction: number) => void,
): Promise<AudioBuffer> {
  if (semitones === 0) return buffer;

  const out = context.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  );

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const shifted = pitchShiftChannel(buffer.getChannelData(ch), semitones);
    const target = out.getChannelData(ch);
    target.set(shifted.subarray(0, Math.min(shifted.length, target.length)));

    onProgress?.((ch + 1) / buffer.numberOfChannels);
    // Yield so the UI can paint the progress we just reported.
    await new Promise((r) => setTimeout(r, 0));
  }

  return out;
}

/** Render an AudioBuffer to a WAV blob, so a shifted track can be saved or re-loaded. */
export function bufferToWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const length = buffer.length * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + length));

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([view], { type: "audio/wav" });
}
