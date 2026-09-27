#!/usr/bin/env node
/**
 * A CHECKED human-verify row must say HOW it was verified.
 *
 * `docs/steward/UX_UPGRADE-*.md` carry `- [ ] \`HV-…\`` rows: things a build
 * cannot decide, to be confirmed by a person or by a test. Ticking one is a
 * claim, and a claim with no evidence beside it is indistinguishable from a
 * guess six weeks later — the same failure as `catch(() => setX([]))`, which
 * collapses "proven" and "assumed" into one state you cannot tell apart.
 *
 * A checklist that READS as verified while nothing was verified is strictly
 * worse than an honest backlog of open rows, because it stops anyone looking.
 *
 * So: a ticked row must carry one of
 *   - a test path            (`…test.tsx`, `__tests__/…`)   — the strongest
 *   - a live-verification note ("VERIFIED LIVE …", "verified live on …")
 *   - a PR / e2e reference   (`#1234`)
 * within its own block (the row plus its indented continuation lines).
 *
 * This is a RATCHET ADDED WHILE CLEAN — all rows passed the day it landed. It
 * exists to stop drift, not to catalogue existing debt. UNCHECKED rows are
 * never flagged: an open row is honest by construction, and the whole point is
 * that leaving one open must stay cheaper than ticking one falsely.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'steward');

// `docs/steward/` is stripped from the white-label bundle by
// `scripts/build-whitelabel-zip.sh`, so an ABSENT directory means "not the
// steward repo" — this governance gate is not applicable and must pass, or the
// shipped bundle's `npm run build` is unpassable for every adopter. A directory
// that EXISTS but holds no UX_UPGRADE-*.md is still a hard failure below: that
// is a real steward misconfiguration, not an adopter.
if (!existsSync(DOCS)) {
  console.log('✓ check-hv-citations: no docs/steward (adopter bundle) — check not applicable.');
  process.exit(0);
}

// The decision logic lives in `hvCitations.mjs` so #2974's four sabotages can be
// ASSERTIONS (`src/__tests__/hvCitations.test.ts`) rather than a claim in a
// commit body. This file keeps the scanning, the population floor, and the exit
// codes; what counts as evidence is defined and tested there.
import { EVIDENCE, NEGATED, rowBlock, classifyRow, resolveRowFloor } from './hvCitations.mjs';

const files = readdirSync(DOCS).filter((f) => f.startsWith('UX_UPGRADE-') && f.endsWith('.md'));
if (files.length === 0) {
  console.error('✗ check-hv-citations: found no UX_UPGRADE-*.md — the scan is looking in the wrong place.');
  process.exit(1);
}

const offenders = [];
let checked = 0;
let totalRows = 0;

for (const file of files) {
  const lines = readFileSync(join(DOCS, file), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- \[[ x]\] `HV-/i.test(lines[i])) totalRows += 1;
    if (!/^- \[x\] `HV-/i.test(lines[i])) continue;
    checked += 1;
    // The row plus its continuation: indented lines only. Stopping at the next
    // list item is not enough — a following UNINDENTED paragraph bled in, so a
    // row reading "nothing whatsoever proves this" passed off a `#2960` two
    // lines below that belonged to no row at all.
    const text = rowBlock(lines, i);
    const id = (lines[i].match(/`(HV-[A-Za-z0-9-]+)`/) ?? [, '?'])[1];
    // ORDER MATTERS. Positive evidence wins: a row citing a real test AND
    // honestly noting what that test does NOT cover ("it never clicks it, so
    // nothing proves the read re-runs") is the BEST kind of row — it is how the
    // SPLIT rows are written. Only a row whose block has no positive citation at
    // all is judged on its negations, which is where "unverified" belongs.
    const verdict = classifyRow(text);
    if (verdict === 'cited') continue;
    offenders.push(verdict === 'negated'
      ? `${file}:${i + 1} ${id} (its own block says the evidence does NOT exist)`
      : `${file}:${i + 1} ${id}`);
  }
}

// VACUITY. A global floor of 1 was not enough: renaming the `HV-` prefix in 25
// of 91 trackers dropped the measured population 48 -> 3 and this gate stayed
// green, hiding 45 ticked claims. So pin the TOTAL row population (checked +
// unchecked) with no slack — if the pattern drifts, the count collapses and
// this fails loudly instead of quietly measuring a rump.
// The floor may only be RAISED from the environment, never lowered — see
// `resolveRowFloor` in `hvCitations.mjs`, where the rule and its four directions
// are asserted (`src/__tests__/hvCitations.test.ts`).
const floorResult = resolveRowFloor(process.env.OPENWOP_HV_ROW_FLOOR);
if (!floorResult.ok) {
  console.error(`✗ check-hv-citations: ${floorResult.error}`);
  console.error('  To accept a smaller corpus, change FILE_ROW_FLOOR in a reviewed commit.');
  process.exit(1);
}
const ROW_FLOOR = floorResult.floor;
if (floorResult.note) console.log(`  (${floorResult.note})`);
if (checked === 0) {
  console.error('✗ check-hv-citations: matched 0 checked rows — the row pattern drifted, so this gate is asserting nothing.');
  process.exit(1);
}
if (totalRows < ROW_FLOOR) {
  console.error(`✗ check-hv-citations: found only ${totalRows} HV rows, expected >= ${ROW_FLOOR}.`);
  console.error('  Rows do not vanish — the id pattern drifted, so this gate is now measuring a fraction');
  console.error('  of the trackers and would pass while most ticked claims are invisible to it.');
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`✗ check-hv-citations: ${offenders.length} of ${checked} checked HV row(s) cite no evidence.`);
  console.error('  Ticking a human-verify row is a claim. Say how it was verified — a test path,');
  console.error('  a "VERIFIED LIVE <date> on <host>" note, or a PR reference — or leave it unchecked.');
  console.error('  An open row is honest; a ticked one with nothing beside it is not.');
  for (const o of offenders) console.error(`    ${o}`);
  process.exit(1);
}

console.log(`✓ check-hv-citations: ${checked} checked HV rows across ${files.length} trackers, all cite evidence.`);
