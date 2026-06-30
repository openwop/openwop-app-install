/**
 * Theme contrast analysis (ADR 0171 Phase E) — the save-time guardrail + the live
 * ContrastChecker readout. The generator already AA-solves the on-colors, so the
 * residual risk is the ADVANCED OVERRIDE tier (arbitrary operator values): this
 * checks the EFFECTIVE token pairs (generated + override) for both modes.
 *   - `ratio` (WCAG 2.x) is the pass/fail of record — the legal floor.
 *   - `apca` (Lc) is advisory only (WCAG 3 has no finalized method).
 * Pairs whose fg or bg token isn't present in the map are skipped (e.g. the stock
 * passthrough leaves some on-colors to CSS relative-color).
 */
import { parseColorToRgb } from './oklch.js';
import { apcaLc, wcagRatio } from './contrast.js';

export interface ContrastPair { mode: 'light' | 'dark'; label: string; ratio: number; threshold: number; pass: boolean; apca: number }
export interface ContrastReport { pairs: ContrastPair[]; pass: boolean }

/** [fg token, bg token, label, WCAG threshold] — 4.5 for text, 3.0 for UI/large. */
const PAIRS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['--ink', '--paper', 'Body text', 4.5],
  ['--ink-3', '--paper', 'Muted text', 4.5],
  ['--clay-text', '--paper', 'Accent text', 4.5],
  ['--clay', '--paper', 'Accent · UI', 3],
];

function analyzeMode(mode: 'light' | 'dark', map: Record<string, string>): ContrastPair[] {
  const out: ContrastPair[] = [];
  for (const [fg, bg, label, threshold] of PAIRS) {
    const f = parseColorToRgb(map[fg] ?? '');
    const b = parseColorToRgb(map[bg] ?? '');
    if (!f || !b) continue;
    const ratio = wcagRatio(f, b);
    out.push({ mode, label, ratio, threshold, pass: ratio >= threshold, apca: apcaLc(f, b) });
  }
  return out;
}

/** Analyze the effective light + dark token maps. `pass` = every checked pair meets
 *  its WCAG AA threshold. */
export function analyzeThemeContrast(light: Record<string, string>, dark: Record<string, string>): ContrastReport {
  const pairs = [...analyzeMode('light', light), ...analyzeMode('dark', dark)];
  return { pairs, pass: pairs.every((p) => p.pass) };
}
