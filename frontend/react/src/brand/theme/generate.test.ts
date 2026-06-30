/**
 * Theme generator (ADR 0171 Phase A) — color math + contrast + the two load-bearing
 * invariants: stock seeds reproduce the current literals byte-identically, and a
 * custom accent's on-colors are AA-solved.
 */
import { describe, expect, it } from 'vitest';
import { hexToRgb, srgbToOklch, oklchToRgb, parseColorToRgb, parseColorToOklch, formatOklch } from './oklch.js';
import { wcagRatio, apcaLc, solveOnColorLightness, relativeLuminance } from './contrast.js';
import { generateTheme, STOCK_ACCENT } from './generate.js';

describe('oklch color math', () => {
  it('round-trips sRGB → OKLCH → sRGB', () => {
    for (const hex of ['#f4f1ea', '#1a1a17', '#6366f1', '#0a7d33']) {
      const rgb = hexToRgb(hex)!;
      const back = oklchToRgb(srgbToOklch(rgb));
      for (let i = 0; i < 3; i++) expect(Math.abs((back[i] ?? 0) - (rgb[i] ?? 0))).toBeLessThan(0.005);
    }
  });
  it('parses hex / oklch / rgb', () => {
    expect(parseColorToRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(parseColorToOklch('oklch(58% 0.13 40)')!.L).toBeCloseTo(0.58, 2);
    expect(parseColorToRgb('rgb(255, 0, 0)')).toEqual([1, 0, 0]);
    expect(parseColorToRgb('oklch(from white l c h)')).toBeNull(); // relative form → caller fallback
  });
  it('formats canonical oklch', () => {
    expect(formatOklch({ L: 0.58, C: 0.13, H: 40 })).toBe('oklch(58% 0.13 40)');
    expect(formatOklch({ L: 0.5, C: 0.1, H: 20 }, 0.1)).toBe('oklch(50% 0.1 20 / 0.1)');
  });
});

describe('contrast', () => {
  it('WCAG ratio: white/black = 21, identical = 1', () => {
    expect(wcagRatio([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 0);
    expect(wcagRatio([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])).toBeCloseTo(1, 5);
  });
  it('APCA: black-on-white is high positive Lc; advisory sign', () => {
    expect(apcaLc([0, 0, 0], [1, 1, 1])).toBeGreaterThan(90);
    expect(apcaLc([1, 1, 1], [0, 0, 0])).toBeLessThan(-90); // reverse polarity
  });
  it('solveOnColorLightness bumps a low-contrast color to meet AA', () => {
    // a mid clay on light paper — start too light, must darken to ≥4.5
    const paper = hexToRgb('#f4f1ea')!;
    const r = solveOnColorLightness({ L: 0.7, C: 0.13, H: 40 }, paper, 4.5);
    expect(r.meetsTarget).toBe(true);
    expect(r.bumpExhausted).toBe(false);
    expect(wcagRatio(oklchToRgb(r.color), paper)).toBeGreaterThanOrEqual(4.5);
  });
  it('flags bumpExhausted when a target is unreachable', () => {
    // 7:1 against a mid-gray with a fixed hue may be unreachable at the chroma — but
    // mainly assert the signal exists when bounds are hit.
    const mid = [0.5, 0.5, 0.5] as const;
    const r = solveOnColorLightness({ L: 0.5, C: 0.0, H: 0 }, mid, 21); // 21:1 vs mid-gray impossible
    expect(r.meetsTarget).toBe(false);
    expect(r.bumpExhausted).toBe(true);
  });
});

describe('generateTheme — invariants', () => {
  it('stock seed reproduces the current literals byte-identically', () => {
    const t = generateTheme({ accentSeed: STOCK_ACCENT });
    expect(t.light['--clay']).toBe(STOCK_ACCENT);
    expect(t.light['--paper']).toBe('#f4f1ea');
    expect(t.light['--ink']).toBe('#1a1a17');
    expect(t.light['--ink-3']).toBe('#66624f');
    expect(t.dark['--paper']).toBe('#1a1a17');
    expect(t.dark['--ink-3']).toBe('#a8a39a');
    expect(t.warnings).toEqual([]);
  });

  it('a custom accent sets --clay exactly and AA-solves the accent text', () => {
    const t = generateTheme({ accentSeed: 'oklch(58% 0.13 250)' }); // a blue
    expect(t.light['--clay']).toBe('oklch(58% 0.13 250)'); // fidelity: exact
    const paper = parseColorToRgb(t.light['--paper'] ?? '')!;
    const text = parseColorToRgb(t.light['--clay-text'] ?? '')!;
    expect(wcagRatio(text, paper)).toBeGreaterThanOrEqual(4.5); // AA guaranteed
    const darkPaper = parseColorToRgb(t.dark['--paper'] ?? '')!;
    const darkText = parseColorToRgb(t.dark['--clay-text'] ?? '')!;
    expect(wcagRatio(darkText, darkPaper)).toBeGreaterThanOrEqual(4.5);
  });

  it('a custom neutral seed generates an AA muted text on the generated surface', () => {
    const t = generateTheme({ accentSeed: STOCK_ACCENT, neutralSeed: 'oklch(60% 0.02 250)' });
    const paper = parseColorToRgb(t.light['--paper'] ?? '')!;
    const ink3 = parseColorToRgb(t.light['--ink-3'] ?? '')!;
    expect(relativeLuminance(paper)).toBeGreaterThan(0.7); // a light paper
    expect(wcagRatio(ink3, paper)).toBeGreaterThanOrEqual(4.5);
  });
});
