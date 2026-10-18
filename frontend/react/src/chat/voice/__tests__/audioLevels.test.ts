/**
 * Live-voice audio math (ADR 0141 RT-8 waveform, RT-9a resample). Breaks if:
 * `resamplePcm` stops interpolating or emits the wrong length (Gemini Live takes
 * 16 kHz input only — the capture runs at the mic's native rate, so wrong samples
 * garble or reject every utterance); or the waveform flattens / flickers.
 * Expected values are independent literals, never the helpers' own output.
 * Sabotage-witnessed in /grade-tests wave 44 (w44g3-al-*).
 */
import { describe, it, expect } from 'vitest';
import { computeRms, perceptualLevel, followEnvelope, pushLevel, resamplePcm } from '../audioLevels.js';

describe('audioLevels (ADR 0141 RT-8) — pure waveform math', () => {
  it('computeRms: silence → 0, full-scale square → 1, half-scale sine ≈ 0.35', () => {
    expect(computeRms(new Float32Array(512))).toBe(0);
    expect(computeRms(new Float32Array(512).fill(1))).toBe(1);
    const sine = new Float32Array(512);
    for (let i = 0; i < sine.length; i += 1) sine[i] = 0.5 * Math.sin((i / sine.length) * Math.PI * 8);
    const rms = computeRms(sine);
    expect(rms).toBeCloseTo(0.35355, 4); // 0.5 / √2
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it('perceptualLevel: lifts quiet speech, clamps at 1', () => {
    // Typical speech RMS ~0.05 would render near-flat linearly; the lift makes it visible.
    expect(perceptualLevel(0.05)).toBeCloseTo(Math.sqrt(0.2), 5);
    expect(perceptualLevel(0)).toBe(0);
    expect(perceptualLevel(1)).toBe(1);
    expect(perceptualLevel(-0.1)).toBe(0); // defensive: negative input clamps
  });

  it('followEnvelope: fast attack (jumps up instantly), slow release (decays gradually)', () => {
    expect(followEnvelope(0.1, 0.9)).toBe(0.9); // attack: next >= prev → snap
    const decayed = followEnvelope(0.9, 0);
    expect(decayed).toBeCloseTo(0.765, 6); // 0.9 × 0.85: one frame retains most of the peak
    // Repeated silence converges toward 0.
    let lv = 0.9;
    for (let i = 0; i < 60; i += 1) lv = followEnvelope(lv, 0);
    expect(lv).toBeLessThan(0.01);
  });

  it('pushLevel: fixed-size rolling history, newest last', () => {
    const h: number[] = [];
    for (let i = 1; i <= 5; i += 1) pushLevel(h, i, 3);
    expect(h).toEqual([3, 4, 5]);
  });
});

describe('resamplePcm (RT-9a) — native-rate capture → Gemini\u2019s required 16 kHz', () => {
  it('is identity when rates match', () => {
    const x = new Float32Array([0.1, -0.2, 0.3]);
    expect(resamplePcm(x, 16000, 16000)).toBe(x);
  });

  it('downsamples 48 kHz → 16 kHz to one third the length', () => {
    const x = new Float32Array(4800).fill(0.5);
    const y = resamplePcm(x, 48000, 16000);
    expect(y.length).toBe(1600);
    expect(y[0]).toBeCloseTo(0.5, 6);
    expect(y[y.length - 1]).toBeCloseTo(0.5, 6);
  });

  it('linear-interpolates between neighbours (44.1 kHz → 16 kHz on a ramp stays a ramp)', () => {
    const x = new Float32Array(441);
    for (let i = 0; i < x.length; i += 1) x[i] = i / (x.length - 1);
    const y = resamplePcm(x, 44100, 16000);
    expect(y.length).toBe(160);
    // A linear ramp resampled linearly is still (approximately) the same ramp.
    for (let i = 1; i < y.length; i += 1) expect((y[i] ?? 0) >= (y[i - 1] ?? 0)).toBe(true);
    expect(y[0]).toBeCloseTo(0, 5);
    // Between-sample values: output o sits at input position o × 44100/16000 =
    // o × 2.75625, and x[i] = i/440, so the interpolated value is o × 2.75625 / 440.
    // (Nearest-neighbour would give floor(pos)/440 instead.)
    expect(y[1]).toBeCloseTo(2.75625 / 440, 6);
    expect(y[159]).toBeCloseTo((159 * 2.75625) / 440, 6);
  });
});
