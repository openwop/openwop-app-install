/**
 * Theme generator (ADR 0171 Phase A) — color math + contrast + the two load-bearing
 * invariants: stock seeds reproduce the shipped CSS tokens byte-identically, and a
 * custom accent's on-colors are AA-SOLVED.
 *
 * The AA cases use seeds whose unsolved derivation FAILS the target (computed in the
 * comments), so they witness the solver inside generateTheme, not merely a seed that
 * happened to pass. Their ratios are computed HERE by the WCAG 2.x formula from an
 * independent OKLCH→sRGB conversion — never with contrast.ts / oklch.ts, the modules
 * under test. The stock case reads foundations/tokens.css, the source of truth, rather
 * than literals copied from it.
 *
 * Sabotage-witnessed (wave 51): bypass any solveOnColorLightness call in generateTheme,
 * or lower TARGET.standard → the AA cases red; drift a stock literal from tokens.css
 * (either side) → the stock case red; reverse the solver's direction / clear
 * bumpExhausted / mangle wcagRatio / flip APCA polarity → the unit cases red.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hexToRgb, srgbToOklch, oklchToRgb, parseColorToRgb, parseColorToOklch, formatOklch } from './oklch.js';
import { wcagRatio, apcaLc, solveOnColorLightness } from './contrast.js';
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
    // Checked with the independent oracle below, not with wcagRatio (the module under test).
    expect(ratioOf(`oklch(${r.color.L * 100}% ${r.color.C} ${r.color.H})`, '#f4f1ea')).toBeGreaterThanOrEqual(4.5);
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

// ── Independent contrast oracle (WCAG 2.x + OKLab → linear sRGB; no product code) ──
const srgbLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** WCAG relative luminance of a `#rrggbb` or `oklch(L% C H)` token value. */
function luminance(value: string): number {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    const [r, g, b] = [hex[1], hex[2], hex[3]].map((h) => srgbLin(parseInt(h ?? '0', 16) / 255));
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  }
  const ok = /^oklch\(([\d.]+)%\s+([\d.]+)\s+(-?[\d.]+)\)$/.exec(value);
  if (!ok) throw new Error(`unparsable token value ${value}`);
  const L = Number(ok[1]) / 100, C = Number(ok[2]), H = (Number(ok[3]) * Math.PI) / 180;
  const a = C * Math.cos(H), b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const r = clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
function ratioOf(fg: string | undefined, bg: string | undefined): number {
  if (!fg || !bg) throw new Error('missing token');
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The value of `token` in a CSS block (exact name: `--ink` never matches `--ink-2`). */
function cssToken(block: string, token: string): string | undefined {
  return new RegExp(`(?:^|[\\s;{])${token}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

describe('generateTheme — invariants', () => {
  it('stock seed reproduces the shipped tokens.css values byte-identically', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../styles/foundations/tokens.css'), 'utf8');
    const lightBlock = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
    const darkStart = css.indexOf(':root.theme-dark {');
    const darkBlock = css.slice(darkStart, css.indexOf('}', darkStart));
    const tokens = ['--paper', '--paper-2', '--rule', '--rule-2', '--ink', '--ink-2', '--ink-3'];
    const t = generateTheme({ accentSeed: STOCK_ACCENT });
    expect(t.light['--clay']).toBe(cssToken(lightBlock, '--clay'));
    for (const tok of tokens) {
      expect(cssToken(lightBlock, tok), `${tok} missing from the light block`).toBeDefined();
      expect(t.light[tok], `light ${tok}`).toBe(cssToken(lightBlock, tok));
      expect(cssToken(darkBlock, tok), `${tok} missing from the dark block`).toBeDefined();
      expect(t.dark[tok], `dark ${tok}`).toBe(cssToken(darkBlock, tok));
    }
    // The anchors themselves, so a matching drift on BOTH sides is still a visible diff.
    expect(t.light['--ink-3']).toBe('#66624f');
    expect(t.dark['--ink-3']).toBe('#a8a39a');
    expect(t.warnings).toEqual([]);
  });

  it('a custom accent sets --clay exactly and AA-solves the accent text', () => {
    const t = generateTheme({ accentSeed: 'oklch(58% 0.13 250)' }); // a blue
    expect(t.light['--clay']).toBe('oklch(58% 0.13 250)'); // fidelity: exact
    expect(ratioOf(t.light['--clay-text'], t.light['--paper'])).toBeGreaterThanOrEqual(4.5);
    expect(ratioOf(t.dark['--clay-text'], t.dark['--paper'])).toBeGreaterThanOrEqual(4.5);

    // A LIGHT accent: its derived light-mode text seed oklch(70% 0.17 95) is only
    // ≈2.35:1 on the stock paper #f4f1ea, so ≥4.5 here is the solver's work.
    const light = generateTheme({ accentSeed: 'oklch(82% 0.15 95)' });
    expect(light.light['--clay']).toBe('oklch(82% 0.15 95)');
    expect(ratioOf(light.light['--clay-text'], light.light['--paper'])).toBeGreaterThanOrEqual(4.5);
    expect(ratioOf(light.light['--clay-strong'], light.light['--paper'])).toBeGreaterThanOrEqual(4.5);

    // A DARK accent: its derived dark-mode text seed oklch(44% 0.1 250) is only
    // ≈2.25:1 on the stock dark paper #1a1a17, so ≥4.5 there is the solver's work.
    const dark = generateTheme({ accentSeed: 'oklch(30% 0.1 250)' });
    expect(ratioOf(dark.dark['--clay-text'], dark.dark['--paper'])).toBeGreaterThanOrEqual(4.5);
    expect(light.warnings).toEqual([]);
    expect(dark.warnings).toEqual([]);
  });

  it('a custom neutral seed generates an AA muted text on the generated surface', () => {
    const t = generateTheme({ accentSeed: STOCK_ACCENT, neutralSeed: 'oklch(60% 0.02 250)' });
    expect(luminance(t.light['--paper'] ?? '')).toBeGreaterThan(0.7); // a light paper
    expect(ratioOf(t.light['--ink-3'], t.light['--paper'])).toBeGreaterThanOrEqual(4.5);
    // At contrastLevel 'high' the target is 7:1; the muted-text seed (L 0.46) is only
    // ≈6.25:1 on that surface, so reaching 7 is the solver's work.
    const high = generateTheme({ accentSeed: STOCK_ACCENT, neutralSeed: 'oklch(60% 0.02 250)', contrastLevel: 'high' });
    expect(ratioOf(high.light['--ink-3'], high.light['--paper'])).toBeGreaterThanOrEqual(7);
  });
});
