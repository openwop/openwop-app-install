/**
 * Pure audio-level math for the live-voice waveform (ADR 0141 RT-8). Kept free of
 * Web-Audio objects so the peak/decay behavior is unit-testable: the component reads
 * time-domain samples from an AnalyserNode and feeds them through these helpers.
 */

/** Root-mean-square of a time-domain sample block, in [0, 1]. Silence → 0. */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/** Perceptual lift for quiet speech: RMS of normal speech sits ~0.02–0.2, which would
 *  render nearly flat. A √ curve spreads the low end while keeping 1 → 1. */
export function perceptualLevel(rms: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, rms) * 4));
}

/** Fast-attack / slow-release envelope follower — peaks snap up instantly, then decay
 *  smoothly so the bars fall gracefully instead of flickering. `release` is the fraction
 *  of the previous level retained per frame (~0.85 at 60fps ≈ 100 ms half-life). */
export function followEnvelope(previous: number, next: number, release = 0.85): number {
  return next >= previous ? next : previous * release + next * (1 - release);
}

/** Push a level into a fixed-size rolling history (newest last), mutating in place —
 *  the scrolling-waveform buffer. Returns the same array for chaining. */
export function pushLevel(history: number[], level: number, size: number): number[] {
  history.push(level);
  while (history.length > size) history.shift();
  return history;
}

/** Linear-interpolation resample of mono PCM samples (RT-9a). Gemini Live requires
 *  16 kHz input, but the capture context runs at the mic's NATIVE rate — forcing a
 *  16 kHz AudioContext trips Chrome's MediaStreamSource rate limitation, so the
 *  rate conversion happens on the samples instead. Same algorithm as the worklet's
 *  inline copy (the worklet global scope can't import); keep them in step. Pure. */
export function resamplePcm(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let o = 0; o < outLen; o += 1) {
    const pos = o * ratio;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = samples[i] ?? 0;
    const b = samples[i + 1] ?? a;
    out[o] = a * (1 - f) + b * f;
  }
  return out;
}
