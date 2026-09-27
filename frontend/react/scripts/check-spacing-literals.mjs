#!/usr/bin/env node
/**
 * Spacing / radius literal RATCHET gate.
 *
 * The spacing scale (`--space-1..6` + half-steps) and radius scale (`--radius`,
 * `--radius-lg`, `--radius-bubble`, `--radius-pill`) are the documented system,
 * but global.css still carries a large tail of raw px/rem literals on gap /
 * padding / margin / border-radius that bypass them (DESIGN.md §5.5 / the UX
 * ultraplan audit). A big-bang migration of all of them risks unverifiable
 * visual shifts, so instead this gate RATCHETS: it counts the literals today and
 * fails if the count goes UP. New code must use tokens; every cleanup that lowers
 * the count lowers the baseline — the violation set can only shrink.
 *
 * A "literal" = a px/rem value on a spacing/radius property that isn't a
 * sanctioned exception (0, 1–3px hairlines, 999px pill, var()/%/calc).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readGateBaseline } from './gateBaseline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// ADR 0510 Phase 3 (DSA-012): EVERY authored stylesheet is in scope, not just
// global.css — a literal doesn't stop being debt by moving files.
const SRC = join(__dirname, '..', 'src');
const walkCss = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkCss(p, acc);
    else if (e.name.endsWith('.css')) acc.push(p);
  }
  return acc;
};

/** Lower this whenever a cleanup removes literals; it must never be raised. */
const BASELINE = readGateBaseline('check-spacing-literals', 'OPENWOP_SPACING_BASELINE', 401);

const PROPS = /(?:^|[;{]\s*)(gap|row-gap|column-gap|margin|margin-(?:top|right|bottom|left)|padding|padding-(?:top|right|bottom|left)|border-radius)\s*:\s*([^;}]+)/g;
// A length literal that is NOT a sanctioned exception.
const LITERAL = /(?<![\w.#-])(\d*\.?\d+)(px|rem)\b/g;
const ALLOW = new Set(['0px', '1px', '2px', '3px', '999px']);

const css = walkCss(SRC).map((f) => readFileSync(f, 'utf8')).join('\n');
let count = 0;
const samples = [];
for (const m of css.matchAll(PROPS)) {
  const value = m[2];
  for (const lit of value.matchAll(LITERAL)) {
    const tok = `${lit[1]}${lit[2]}`;
    if (ALLOW.has(tok)) continue;
    if (lit[2] === 'rem' && Number(lit[1]) === 0) continue;
    count += 1;
    if (samples.length < 6) samples.push(`${m[1]}: …${tok}…`);
  }
}

if (count > BASELINE) {
  console.error(`✗ check-spacing-literals: ${count} spacing/radius literals (baseline ${BASELINE}). You ADDED ${count - BASELINE}.`);
  console.error('  Use --space-*/--radius* tokens for gap/padding/margin/border-radius. Examples of current literals:');
  for (const s of samples) console.error(`    ${s}`);
  process.exit(1);
}
const note = count < BASELINE ? ` — down ${BASELINE - count}; lower BASELINE to ${count} in this file.` : '';
console.log(`✓ check-spacing-literals: ${count} spacing/radius literals (baseline ${BASELINE}, ratchet holds).${note}`);
