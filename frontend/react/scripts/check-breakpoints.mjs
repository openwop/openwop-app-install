#!/usr/bin/env node
/**
 * Breakpoint vocabulary gate (ADR 0510 Phase 3, DSA-024).
 *
 * Responsive thresholds express layout INTENT, not device brands. The governed
 * vocabulary below is the named set (plus each value's max-width complement,
 * `B - 1`); a new media query must use one of these. The stragglers that
 * predate the vocabulary are held in a shrink-only EXCEPTIONS ledger — they
 * are Phase 7 migration targets, not license for new ad-hoc widths.
 *
 *   content  480 · 600 · 640   — text/measure and small-panel adaptations
 *   shell    720 · 760 · 860   — app-shell drawer/column collapses
 *   rail     900               — side-rail visibility
 *   canvas   1024              — editor chassis minimums
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

const VOCABULARY = [480, 600, 640, 720, 760, 860, 900, 1024];
const ALLOWED = new Set(VOCABULARY.flatMap((b) => [`${b}px`, `${b - 1}px`]));

/** Pre-vocabulary stragglers (file-scoped, shrink-only — migrate in Phase 7,
 *  never add). Each entry is `[threshold, maxOccurrences]`. */
const EXCEPTIONS = new Map([
  ['620px', 1],
  ['700px', 3],
  ['761px', 2],
  ['861px', 2],
  ['920px', 1],
  ['1020px', 1],
]);

const walkCss = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkCss(p, acc);
    else if (e.name.endsWith('.css')) acc.push(p);
  }
  return acc;
};

const counts = new Map();
const sites = [];
for (const file of walkCss(SRC)) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/@media[^\n{]*\((?:min|max)-width:\s*([0-9.]+(?:px|rem|em))/g)) {
      const t = m[1];
      counts.set(t, (counts.get(t) ?? 0) + 1);
      sites.push({ t, at: `${relative(SRC, file)}:${i + 1}` });
    }
  });
}

const problems = [];
for (const [t, n] of counts) {
  if (ALLOWED.has(t)) continue;
  const cap = EXCEPTIONS.get(t);
  if (cap === undefined) {
    problems.push(`${t} (${n}×) is not in the governed vocabulary — use ${VOCABULARY.join('/')}px (or B−1 for max-width). At: ${sites.filter((s) => s.t === t).map((s) => s.at).join(', ')}`);
  } else if (n > cap) {
    problems.push(`${t}: ${n} occurrences exceed the shrink-only exception cap (${cap}) — new uses of a straggler threshold are banned.`);
  }
}

if (problems.length) {
  console.error(`✗ check-breakpoints: ${problems.length} vocabulary violation(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ check-breakpoints: ${counts.size} distinct thresholds, all in the governed vocabulary or the shrink-only exception ledger.`);
