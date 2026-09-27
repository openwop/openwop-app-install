#!/usr/bin/env node
/**
 * Typography literal RATCHET gate (ADR 0510 Phase 3, DSA-007).
 *
 * The type scale (`--text-display/title/subtitle/lg/body/sm/eyebrow`) and the
 * weight conventions are the documented system, but the stylesheet carries a
 * large tail of raw `font-size` px/rem values and numeric `font-weight`s that
 * bypass them — which is why the font-scale accessibility preference
 * multiplies tokens and misses literals. Same policy as the spacing gate:
 * RATCHET. Counts may only fall; lower the baselines with every cleanup.
 *
 * Scope: every authored stylesheet under src/ (DSA-012).
 * Sanctioned: `var()`/`calc()`/`%`/`em` values, `font-size: 0`, and weights
 * expressed via keywords (`normal`, `bold`) — the migration target is the
 * TOKEN scale, and `em` sizes are relative (they follow the scale).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readGateBaseline } from './gateBaseline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

/** Lower these whenever a cleanup removes literals; never raise them. */
const SIZE_BASELINE = readGateBaseline('check-typography-literals', 'OPENWOP_FONTSIZE_BASELINE', 589);
const WEIGHT_BASELINE = readGateBaseline('check-typography-literals', 'OPENWOP_FONTWEIGHT_BASELINE', 0);

const walkCss = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkCss(p, acc);
    else if (e.name.endsWith('.css')) acc.push(p);
  }
  return acc;
};
const css = walkCss(SRC).map((f) => readFileSync(f, 'utf8')).join('\n');

const sizes = [...css.matchAll(/font-size\s*:\s*([^;}]+)/g)]
  .filter((m) => /(?<![\w.#-])\d*\.?\d+(px|rem)\b/.test(m[1]))
  .filter((m) => !/^\s*0\s*$/.test(m[1]));
const weights = [...css.matchAll(/font-weight\s*:\s*(\d{3})\b/g)];

let failed = false;
if (sizes.length > SIZE_BASELINE) {
  console.error(`✗ check-typography-literals: ${sizes.length} raw font-size literals (baseline ${SIZE_BASELINE}). You ADDED ${sizes.length - SIZE_BASELINE}.`);
  console.error('  Use the --text-* scale tokens so the font-scale preference reaches your text.');
  failed = true;
}
if (weights.length > WEIGHT_BASELINE) {
  console.error(`✗ check-typography-literals: ${weights.length} numeric font-weight literals (baseline ${WEIGHT_BASELINE}). You ADDED ${weights.length - WEIGHT_BASELINE}.`);
  failed = true;
}
if (failed) process.exit(1);
const note = (n, b, name) => (n < b ? ` — ${name} down ${b - n}; lower the baseline to ${n}.` : '');
console.log(`✓ check-typography-literals: ${sizes.length} font-size (baseline ${SIZE_BASELINE})${note(sizes.length, SIZE_BASELINE, 'sizes')} · ${weights.length} font-weight (baseline ${WEIGHT_BASELINE})${note(weights.length, WEIGHT_BASELINE, 'weights')}.`);
