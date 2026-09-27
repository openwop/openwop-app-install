/**
 * Theme contrast analysis (ADR 0171 Phase E): a generated theme passes AA by
 * construction; an advanced override that breaks a pair is caught.
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
  });

  it('catches an advanced override that breaks body-text contrast', () => {
    const t = generateTheme({ accentSeed: 'oklch(58% 0.13 250)' });
    // Override --ink to almost the paper color → body text becomes unreadable.
    const badLight = { ...t.light, '--ink': '#f0ede6' };
    const report = analyzeThemeContrast(badLight, t.dark);
    expect(report.pass).toBe(false);
    const body = report.pairs.find((p) => p.mode === 'light' && p.label === 'Body text');
    expect(body?.pass).toBe(false);
  });

  it('reports an APCA Lc advisory alongside the WCAG ratio', () => {
    const t = generateTheme({ accentSeed: 'oklch(58% 0.13 40)', neutralSeed: 'oklch(60% 0.01 60)' });
    const report = analyzeThemeContrast(t.light, t.dark);
    const body = report.pairs.find((p) => p.label === 'Body text');
    expect(body).toBeDefined();
    expect(Math.abs(body!.apca)).toBeGreaterThan(0); // an Lc value is present
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
