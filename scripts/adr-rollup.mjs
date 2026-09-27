#!/usr/bin/env node
/**
 * ADR 0548 program roll-up — DERIVED, not hand-maintained.
 *
 * WHY THIS EXISTS. ADR 0548 is the umbrella for the A-grade program, and its
 * roll-up section restated each child ADR's state in prose. Prose copied from
 * eight other documents goes stale the moment any of them merges, and nothing
 * could go red when it did: on 2026-08-18 the roll-up (last reconciled by H44,
 * `a847daa50`) trailed SIX program merges — #3315, #3317, #3318, #3319, #3322,
 * #3325 — and 0548's own `Status:` line asserted three things that were false:
 * "0555 stops at P1", "0556 P2/P4 open", "0554 P3/P4 open".
 *
 * The umbrella's own invariant 5 already says an accepted ADR is not evidence.
 * A roll-up that can drift is the same defect one level up: a document that
 * looks like a status board and is actually a snapshot of one afternoon.
 *
 * WHAT IT DOES, AND DELIBERATELY DOES NOT DO. It QUOTES each child's `Status:`
 * line. It does not parse phase tables, infer which phases are done, or grade
 * anything — every one of those is prose inference, and an inference that is
 * wrong is worse than the staleness it replaces. Quoting has one failure mode
 * (the quote is out of date) and this script closes exactly that one.
 *
 *   node scripts/adr-rollup.mjs            # rewrite the generated block
 *   node scripts/adr-rollup.mjs --check    # fail if it differs (CI)
 *
 * A child ADR's status changes -> `--check` goes red -> someone re-reads the
 * umbrella. That is the whole contract.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADR_DIR = join(ROOT, 'docs', 'adr');
const UMBRELLA = '0548';
/** The program's children, per ADR 0548's Decision table. */
const CHILDREN = ['0549', '0550', '0551', '0552', '0553', '0554', '0555', '0556'];

const BEGIN = '<!-- BEGIN GENERATED: program-rollup (scripts/adr-rollup.mjs) -->';
const END = '<!-- END GENERATED: program-rollup -->';

/** `docs/adr/0554-compensation-....md` for `0554`. */
function adrPath(num) {
  const hit = readdirSync(ADR_DIR).find((f) => f.startsWith(`${num}-`) && f.endsWith('.md'));
  if (!hit) throw new Error(`adr-rollup: no ADR file for ${num} — the program's child list is out of date.`);
  return join(ADR_DIR, hit);
}

/** The `# ADR NNNN — title` heading, minus the number. */
function titleOf(text, num) {
  const m = /^#\s*ADR\s+\d+\s*[—-]\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : `(no title heading in ${num})`;
}

/**
 * The `Status:` line, flattened to one line and clipped.
 *
 * These lines run to hundreds of characters (they are the program's real
 * ledger), so the roll-up quotes the LEAD — enough to see the phase claims —
 * and links to the ADR for the rest. Clipping is why the check is stable: it
 * does not fire on a typo fix deep in a status line, only on a changed claim.
 */
function statusOf(text, num) {
  const m = /^Status:\s*(.+)$/m.exec(text);
  if (!m) throw new Error(`adr-rollup: ADR ${num} has no 'Status:' line.`);
  const flat = m[1].replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

function render() {
  const rows = CHILDREN.map((num) => {
    const p = adrPath(num);
    const text = readFileSync(p, 'utf8');
    const file = p.slice(ADR_DIR.length + 1);
    return `| [${num}](${file}) | ${titleOf(text, num)} | ${statusOf(text, num)} |`;
  });
  return [
    BEGIN,
    '',
    '<!-- Do not edit by hand: `node scripts/adr-rollup.mjs` regenerates it and',
    '     `--check` fails when it drifts. Each cell QUOTES the child ADR\'s own',
    '     `Status:` line (clipped); it is not an interpretation of one. -->',
    '',
    '| ADR | Scope | Its own `Status:` line, quoted |',
    '|---|---|---|',
    ...rows,
    '',
    END,
  ].join('\n');
}

const umbrellaPath = adrPath(UMBRELLA);
const umbrella = readFileSync(umbrellaPath, 'utf8');
const generated = render();

const start = umbrella.indexOf(BEGIN);
const stop = umbrella.indexOf(END);
if (start === -1 || stop === -1) {
  console.error(
    `✗ adr-rollup: ADR ${UMBRELLA} has no generated block. Add these two markers where the roll-up belongs:\n`
      + `    ${BEGIN}\n    ${END}`,
  );
  process.exit(1);
}
const current = umbrella.slice(start, stop + END.length);
const next = umbrella.slice(0, start) + generated + umbrella.slice(stop + END.length);

if (process.argv.includes('--check')) {
  if (current === generated) {
    console.log(`✓ adr-rollup: ADR ${UMBRELLA}'s roll-up matches all ${CHILDREN.length} child ADRs.`);
    process.exit(0);
  }
  console.error(
    `✗ adr-rollup: ADR ${UMBRELLA}'s roll-up no longer matches its children.\n`
      + '  A child ADR\'s Status line changed and the umbrella still quotes the old one — the exact drift\n'
      + '  this check exists for (H44\'s reconciliation trailed six merges before it was caught by hand).\n'
      + '  Run: node scripts/adr-rollup.mjs   then re-read the umbrella\'s own Status line and exit criteria.',
  );
  process.exit(1);
}

writeFileSync(umbrellaPath, next);
console.log(`✓ adr-rollup: regenerated ADR ${UMBRELLA}'s roll-up from ${CHILDREN.length} child ADRs.`);
