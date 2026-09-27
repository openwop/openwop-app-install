/**
 * Theme contrast analysis (ADR 0171 Phase E) — the save-time guardrail + the live
 * ContrastChecker readout. The generator already AA-solves the on-colors, so the
 * residual risk is the ADVANCED OVERRIDE tier (arbitrary operator values): this
 * checks the EFFECTIVE token pairs (generated + override) for both modes.
 *   - `ratio` (WCAG 2.x) is the pass/fail of record — the legal floor.
 *   - `apca` (Lc) is advisory only (WCAG 3 has no finalized method).
 * Required pairs are fail-closed: a missing or invalid token is itself a failed
 * result. Fixed stock tokens are merged before analysis so generated themes are
 * evaluated exactly as they render.
 */
import { parseColorToRgb } from './oklch.js';
import { apcaLc, wcagRatio } from './contrast.js';
import { stockOnColorFallbacks } from './generate.js';

export type ContrastIssue = 'missing-token' | 'invalid-color' | 'insufficient-contrast';
export interface ContrastPair { mode: 'light' | 'dark'; label: string; foreground: string; background: string; ratio: number; threshold: number; pass: boolean; apca: number; issue?: ContrastIssue }
export interface ContrastReport { pairs: ContrastPair[]; pass: boolean }

/** Values owned by the foundation rather than the generative theme. */
export const FIXED_THEME_TOKENS: Readonly<Record<string, string>> = {
  '--color-on-scrim': '#fff',
};

/** [fg token, bg token, label, WCAG threshold] — 4.5 for text, 3.0 for UI/large. */
const PAIRS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['--ink', '--paper', 'Body text', 4.5],
  ['--ink-3', '--paper', 'Muted text', 4.5],
  ['--clay-text', '--paper', 'Accent text', 4.5],
  ['--clay', '--paper', 'Accent · UI', 3],
  // DS-4: the primary button is the loudest element — validate its on-color,
  // and muted text on the secondary surface.
  ['--color-on-scrim', '--clay-strong', 'Primary button text', 4.5],
  ['--ink-3', '--paper-2', 'Muted · secondary surface', 4.5],
];

function analyzeMode(mode: 'light' | 'dark', map: Record<string, string>): ContrastPair[] {
  const out: ContrastPair[] = [];
  for (const [fg, bg, label, threshold] of PAIRS) {
    const fgValue = map[fg];
    const bgValue = map[bg];
    const missing = !fgValue || !bgValue;
    const f = parseColorToRgb(fgValue ?? '');
    const b = parseColorToRgb(bgValue ?? '');
    if (!f || !b) {
      out.push({ mode, label, foreground: fg, background: bg, ratio: 0, threshold, pass: false, apca: 0, issue: missing ? 'missing-token' : 'invalid-color' });
      continue;
    }
    const ratio = wcagRatio(f, b);
    const pass = ratio >= threshold;
    out.push({ mode, label, foreground: fg, background: bg, ratio, threshold, pass, apca: apcaLc(f, b), ...(!pass ? { issue: 'insufficient-contrast' as const } : {}) });
  }
  return out;
}

/** Analyze the effective light + dark token maps. `pass` = every checked pair meets
 *  its WCAG AA threshold. */
export function analyzeThemeContrast(light: Record<string, string>, dark: Record<string, string>): ContrastReport {
  // Merge order = how the app actually renders: foundation fixed tokens, then
  // the resolved stock fallbacks CSS provides for tokens a partial map omits
  // (the stock passthrough leaves derived on-colors to relative-color), then
  // the candidate map itself. Every PAIRS token therefore has an effective
  // value; `missing-token` survives as the fail-closed guard for a future pair
  // whose token has no foundation fallback.
  const stock = stockOnColorFallbacks();
  const pairs = [
    ...analyzeMode('light', { ...FIXED_THEME_TOKENS, ...stock.light, ...light }),
    ...analyzeMode('dark', { ...FIXED_THEME_TOKENS, ...stock.dark, ...dark }),
  ];
  return { pairs, pass: pairs.every((p) => p.pass) };
}
