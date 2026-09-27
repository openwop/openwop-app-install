#!/usr/bin/env node
/**
 * Type-check the UNIT TESTS as a shrink-only ratchet.
 *
 * `tsconfig.json` excludes `src/**​/__tests__/**​`, and vitest transpiles without
 * checking — so a type error in any of the 506 test files reaches main SILENTLY.
 * Scope (2026-08-16): `tsconfig.test.json` includes all of `src` AND the
 * build-gate tests under `scripts` — those were invisible to this ratchet
 * before, the exact guard-with-no-guard hole they were written to close.
 * (Glob paths in this comment carry a zero-width space so their slash-star
 * sequences cannot terminate this block comment — the bug this line once had.)
 * That is the same class fixed for `e2e/` in #2827, where the cost happened to be
 * one error. Here it was MEASURED at ~200, which is a migration, not a drive-by.
 *
 * WHY A RATCHET AND NOT A WALL. Turning the check on outright would put 200 errors
 * between every developer and their merge. A gate that red does not get fixed — it
 * gets bypassed, and then it protects nothing. So existing debt is tolerated and
 * GROWTH is not: the count may fall freely and may never rise.
 *
 * WHY NOT JUST RELAX THE NOISY RULES. The top codes are TS2532 (possibly
 * undefined) and TS2493 (tuple index out of range) — overwhelmingly fixtures
 * indexing arrays. Relaxing `noUncheckedIndexedAccess` would make the number
 * vanish without making a single test safer, and would weaken the app's own
 * checking as a side effect. The number should come down by fixing fixtures.
 *
 * The baseline is deliberately the exact measured count, not a round number: a
 * padded baseline is a gate that tolerates regressions it never mentions — the
 * failure `check-failed-read-sentinels` had when its baseline sat at 100 against
 * a real count of 81.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The two decision points below — "is this baseline legitimate?" and "did tsc
// actually CHECK anything?" — live in `testTypesRatchet.mjs` as pure functions so
// they can be tested without a two-minute tsc pass. Both had shipped defects that
// only hand-running the failure case revealed; the tests in
// `src/__tests__/testTypesRatchet.test.ts` are those probes, kept.
import { FILE_BASELINE, resolveBaseline, classifyTscResult } from './testTypesRatchet.mjs';

const baselineResult = resolveBaseline(process.env.OPENWOP_TEST_TYPES_BASELINE, FILE_BASELINE);
if (!baselineResult.ok) {
  console.error(`\n✗ check-test-types: ${baselineResult.error}\n`);
  process.exit(1);
}
const BASELINE = baselineResult.baseline;
if (baselineResult.note) console.log(`  (${baselineResult.note})`);

let raw = { output: '', status: 0, spawnFailed: false, spawnCode: '' };
try {
  execFileSync(
    process.execPath,
    [resolve(ROOT, 'node_modules/typescript/bin/tsc'), '-p', resolve(ROOT, 'tsconfig.test.json')],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (err) {
  // A spawn failure (ENOENT/EACCES) has no exit status at all — tsc never ran.
  raw = {
    output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    status: err.status ?? 1,
    spawnFailed: Boolean(err.code) && err.status === undefined,
    spawnCode: err.code ?? '',
  };
}

const classified = classifyTscResult(raw);
if (!classified.ok) {
  console.error(`\n✗ check-test-types [${classified.reason}]: ${classified.detail}`);
  console.error('  Refusing to read an unchecked project as a low error count — that would');
  console.error('  report an improvement nobody earned.\n');
  process.exit(1);
}

const { count, errors } = classified;

if (count > BASELINE) {
  console.error(`\n✗ check-test-types: ${count} type error(s) in unit tests — baseline is ${BASELINE}.\n`);
  console.error('  The count GREW. Unit tests are not type-checked by `npm run build`, so this');
  console.error('  is the only thing standing between a broken test type and main.\n');
  // Show the newest-looking ones first — most useful when a change added them.
  for (const e of errors.slice(0, 12)) console.error(`  ${e}`);
  if (errors.length > 12) console.error(`  … and ${errors.length - 12} more`);
  console.error('\n  Fix the new errors. Do NOT raise the baseline to go green.\n');
  process.exit(1);
}

if (count < BASELINE) {
  console.log(`✓ check-test-types: ${count} type error(s) in unit tests (baseline ${BASELINE}).`);
  console.log(`  — down ${BASELINE - count}; lower BASELINE to ${count} in this file so the gain is locked in.`);
} else {
  console.log(`✓ check-test-types: ${count} type error(s) in unit tests (baseline ${BASELINE}, ratchet holds).`);
}
