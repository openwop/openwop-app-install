#!/usr/bin/env node
/**
 * ADR 0509 Phase 4b — is the promoted browser lane REAL COVERAGE OR THEATRE?
 *
 * Phase 3 put the Playwright lane in the default `npm run ci`, but the auto path
 * skips when the machine cannot run it (no Chromium). Phase 4's escalation gate
 * was written as "green across a meaningful number of merges" — a criterion that
 * was never defined, never instrumented, and therefore could never be discharged.
 * A gate nobody can evaluate is exactly the half-measure that reads as progress
 * and then sits there forever; the ADR warned about that and then committed it.
 *
 * `scripts/ci.sh` now appends one line per gate run to a local ledger. This reads
 * it and answers the only question that matters: WHAT FRACTION OF GATE RUNS
 * ACTUALLY EXECUTED THE BROWSER LANE.
 *
 * The threshold below is a judgement, and it is stated rather than implied: if
 * the lane runs on fewer than 80% of gate invocations, promotion is not buying
 * coverage — it is buying the appearance of coverage — and ADR 0509 should either
 * escalate (make Chromium mandatory) or revert to a pre-push-only hook.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = process.env.OPENWOP_CI_E2E_LEDGER ?? resolve(ROOT, '.openwop-ci-e2e-ledger');

/** Below this run-rate, promotion is theatre rather than coverage. */
const HEALTHY_RUN_RATE = 0.8;

if (!existsSync(LEDGER)) {
  console.log('e2e ledger: no runs recorded yet.');
  console.log(`  (expected at ${LEDGER} — it is written by scripts/ci.sh on every gate run)`);
  console.log('  Run `npm run ci` at least once, then re-run this report.');
  process.exit(0);
}

const rows = readFileSync(LEDGER, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [at, sha, outcome] = l.split('\t');
    return { at, sha, outcome: outcome ?? 'unset' };
  });

if (rows.length === 0) {
  console.log('e2e ledger: file exists but is empty.');
  process.exit(0);
}

const ran = rows.filter((r) => r.outcome.startsWith('ran:'));
const passed = rows.filter((r) => r.outcome === 'ran:pass');
const failed = rows.filter((r) => r.outcome === 'ran:fail');
const skipped = rows.filter((r) => r.outcome.startsWith('skipped:'));
const rate = ran.length / rows.length;

console.log(`e2e gate ledger — ${rows.length} run(s) since ${rows[0].at}\n`);
console.log(`  RAN     ${ran.length}  (${passed.length} pass, ${failed.length} fail)`);
console.log(`  SKIPPED ${skipped.length}`);
console.log(`  run rate ${(rate * 100).toFixed(0)}%  (healthy ≥ ${HEALTHY_RUN_RATE * 100}%)\n`);

if (skipped.length > 0) {
  const why = new Map();
  for (const r of skipped) {
    const reason = r.outcome.slice('skipped:'.length).split(' —')[0].split(' (')[0];
    why.set(reason, (why.get(reason) ?? 0) + 1);
  }
  console.log('  why it skipped:');
  for (const [reason, n] of [...why.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${reason}`);
  }
  console.log('');
}

// The verdict is the point of the file. State it plainly, including the case
// where there is not yet enough data to have one.
if (rows.length < 10) {
  console.log(`VERDICT: not enough data (${rows.length} runs; want >= 10 before judging).`);
} else if (rate >= HEALTHY_RUN_RATE) {
  console.log('VERDICT: the promoted lane is REAL COVERAGE — it runs on most gate invocations.');
  console.log('  ADR 0509 Phase 4 may escalate: make Chromium mandatory so the residual skips stop.');
} else {
  console.log('VERDICT: the promoted lane is closer to THEATRE than coverage.');
  console.log('  It skips on most gate invocations, so "green" does not mean the browser lane ran.');
  console.log('  ADR 0509 says: escalate (mandatory Chromium) or revert to a pre-push-only hook.');
  console.log('  Do NOT leave it as-is looking like coverage.');
}
