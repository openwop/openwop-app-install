/**
 * Theme contrast analysis (ADR 0171 Phase E, ADR 0510 §5): a generated theme passes AA
 * by construction; an advanced override that breaks a pair is caught at the WCAG 2.x
 * thresholds (4.5:1 text, 3:1 UI) — pinned literally here, never read back from the
 * analyzer, because those numbers are the legal floor the analyzer exists to enforce.
 *
 * Sabotage-witnessed (wave 51): `every`→`some`, override merged under the stock map,
 * Body text threshold 4.5→3, an unparsable value skipped instead of failed, a pair
 * dropped, APCA zeroed or sign-flipped, or the on-scrim value drifting from tokens.css
 * — each turns its case red.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateTheme } from './generate.js';
import { analyzeThemeContrast, FIXED_THEME_TOKENS } from './analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('analyzeThemeContrast', () => {
  it('a generated custom theme passes AA on every checked pair (both modes)', () => {
    const t = generateTheme({ accentSeed: 'oklch(58% 0.13 250)', neutralSeed: 'oklch(60% 0.02 250)' });
    const report = analyzeThemeContrast(t.light, t.dark);
    expect(report.pairs.length).toBeGreaterThan(0);
    expect(report.pass).toBe(true);
    for (const p of report.pairs) expect(p.ratio).toBeGreaterThanOrEqual(p.threshold);
    // The thresholds themselves, as WCAG 2.x defines them (literals, per mode).
    for (const mode of ['light', 'dark'] as const) {
      expect(Object.fromEntries(report.pairs.filter((p) => p.mode === mode).map((p) => [p.label, p.threshold]))).toEqual({
        'Body text': 4.5, 'Muted text': 4.5, 'Accent text': 4.5, 'Accent · UI': 3,
        'Primary button text': 4.5, 'Muted · secondary surface': 4.5,
      });
    }
  });

  it('catches an advanced override that breaks body-text contrast', () => {
    const t = generateTheme({ accentSeed: 'oklch(58% 0.13 250)' });
    // Override --ink to almost the paper color → body text becomes unreadable.
    const badLight = { ...t.light, '--ink': '#f0ede6' };
    const report = analyzeThemeContrast(badLight, t.dark);
    expect(report.pass).toBe(false);
    const body = report.pairs.find((p) => p.mode === 'light' && p.label === 'Body text');
    expect(body?.pass).toBe(false);

    // A body text that clears the UI floor (3:1) but NOT the text floor (4.5:1) still
    // fails: #7a7a7a on the stock paper #f4f1ea is 3.81:1 by the WCAG formula
    // (relative luminance 0.1946 vs 0.8808; computed by hand, not by the analyzer).
    const midGray = analyzeThemeContrast({ ...t.light, '--ink': '#7a7a7a' }, t.dark);
    const mid = midGray.pairs.find((p) => p.mode === 'light' && p.label === 'Body text');
    expect(mid?.ratio).toBeCloseTo(3.81, 2);
    expect(mid?.pass).toBe(false);
    expect(midGray.pass).toBe(false);
  });

  it('reports an APCA Lc advisory alongside the WCAG ratio', () => {
    // The stock surfaces (empty maps resolve to them), so the pair is known exactly.
    const report = analyzeThemeContrast({}, {});
    const body = report.pairs.find((p) => p.mode === 'light' && p.label === 'Body text');
    if (!body) throw new Error('no light Body text pair');
    // Dark ink #1a1a17 on light paper #f4f1ea: normal polarity, Lc ≈ +96.1 by the
    // APCA 0.1.9 constants (computed by hand). Sign = polarity, so it must be POSITIVE.
    expect(body.apca).toBeCloseTo(96.1, 0);
    // …and the WCAG ratio is the pass/fail of record, alongside it.
    expect(body.pass).toBe(true);
  });

  it('checks the fixed on-scrim token and fails closed for unparsable values', () => {
    const t = generateTheme({ accentSeed: 'oklch(58% 0.13 40)' });
    const report = analyzeThemeContrast({ ...t.light, '--clay-strong': '#fff' }, t.dark);
    expect(report.pairs.find((p) => p.label === 'Primary button text' && p.mode === 'light')?.pass).toBe(false);

    // An unparsable value is a FAILED pair, never a skipped one.
    const hostile = analyzeThemeContrast({ '--paper': 'red;}x{y:1' }, {});
    expect(hostile.pass).toBe(false);
    expect(hostile.pairs.some((p) => p.issue === 'invalid-color')).toBe(true);
  });

  it('empty maps analyze as the effective STOCK theme — every pair evaluated, all AA', () => {
    // The stock passthrough leaves derived on-colors to CSS relative-color;
    // the analyzer merges the resolved stock fallbacks, so nothing is skipped
    // and the hand-tuned stock identity passes AA in both modes.
    const report = analyzeThemeContrast({}, {});
    expect(report.pairs).toHaveLength(12);
    expect(report.pairs.every((p) => p.ratio > 0)).toBe(true); // no skipped/zeroed pair
    expect(report.pass).toBe(true);
  });
});

describe('FIXED_THEME_TOKENS parity', () => {
  it('matches the foundation value in global.css (the analyzer must not lie)', () => {
    const css = readFileSync(join(__dirname, '../../styles/foundations/tokens.css'), 'utf8');
    for (const [token, value] of Object.entries(FIXED_THEME_TOKENS)) {
      const m = css.match(new RegExp(`${token}:\\s*([^;]+);`));
      expect(m?.[1]?.trim(), `${token} missing from foundations/tokens.css`).toBe(value);
    }
  });
});
