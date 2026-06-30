/**
 * Theme contrast analysis (ADR 0171 Phase E): a generated theme passes AA by
 * construction; an advanced override that breaks a pair is caught.
 */
import { describe, expect, it } from 'vitest';
import { generateTheme } from './generate.js';
import { analyzeThemeContrast } from './analyze.js';

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
});
