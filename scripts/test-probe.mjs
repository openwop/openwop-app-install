#!/usr/bin/env node
/**
 * test-probe — Tier 2 instrument of the /grade-tests skill: sabotage probes.
 *
 * A green test proves nothing about whether it CAN fail. A probe breaks one
 * thing in the code a test claims to guard, runs only that test file, records
 * which cases went red, and restores the file. One probe proves one assertion.
 *
 * Probes file (JSON array):
 *   { "id": "short-id",
 *     "lane": "backend" | "frontend",
 *     "src": "<path from repo root>",
 *     "old": "<exact text — must occur EXACTLY once in src>",
 *     "new": "<replacement>",
 *     "test": "<test path relative to the lane dir>",
 *     "expect_red": ["<substring of a case title that must fail>", …],  // optional
 *     "env": { "NAME": "value" } }                                       // optional
 *
 * A probe that edits a pack (`packs/…`, `examples/…`) breaks that pack's
 * trust manifest, so every run fails `pack_untrusted` — red for the wrong
 * reason. Such probes run with OPENWOP_PACK_TRUST_ALLOW_UNSIGNED=true, and any
 * report that still mentions `pack_untrusted` is an "error", never a witness.
 *
 * Output: one JSON line per probe — red cases, and `verdict`:
 *   "witnessed"  every expect_red substring matched a failing case
 *   "vacuous"    nothing went red (the claim cannot fail under this break)
 *   "other-red"  something went red, but not the expected case(s)
 *   "error"      the probe could not be applied or run
 *
 * Safety: refuses to touch a src file that is already dirty, restores it in a
 * finally by writing back the bytes it read (then `git checkout` as a second try),
 * VERIFIES the file is clean, and stops the run if it is not, and prints the worktree status at the
 * end. Run it ONLY in your own worktree, and never two at once in one
 * worktree — a concurrent probe's edit would leak into the other's run.
 *
 * Usage: node scripts/test-probe.mjs <probes.json> [--out <dir>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The repo is the one you run from (your own worktree), not the one this file
// lives in — a probe applied to the wrong checkout edits and tests the wrong code.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const LANES = { backend: 'backend/typescript', frontend: 'frontend/react' };

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args.splice(outIdx, 2)[1] : mkdtempSync(join(tmpdir(), 'test-probe-'));
const probes = JSON.parse(readFileSync(args[0], 'utf8'));

const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });

function runProbe(p) {
  if (!LANES[p.lane]) return { id: p.id, verdict: 'error', error: `unknown lane ${p.lane}` };
  if (git('diff', '--quiet', '--', p.src).status !== 0) return { id: p.id, verdict: 'error', error: 'src already dirty' };
  const srcAbs = join(ROOT, p.src);
  const text = readFileSync(srcAbs, 'utf8');
  const n = text.split(p.old).length - 1;
  if (n !== 1) return { id: p.id, verdict: 'error', error: `old text matched ${n} times` };
  try {
    writeFileSync(srcAbs, text.replace(p.old, () => p.new));
    const report = join(outDir, `probe-${p.id}.json`);
    rmSync(report, { force: true }); // never read a previous run's report
    const packEdit = /^(packs|examples)\//.test(p.src);
    const env = { ...process.env, ...(packEdit ? { OPENWOP_PACK_TRUST_ALLOW_UNSIGNED: 'true' } : {}), ...(p.env ?? {}) };
    const run = spawnSync('node', ['node_modules/vitest/vitest.mjs', 'run', p.test, '--reporter=json', `--outputFile=${report}`],
      { cwd: join(ROOT, LANES[p.lane]), encoding: 'utf8', env });
    let r;
    try { r = JSON.parse(readFileSync(report, 'utf8')); } catch {
      return { id: p.id, verdict: 'error', error: `vitest produced no report: ${(run.stderr || run.stdout || '').trim().slice(-300)}` };
    }
    if (/pack_untrusted/.test(JSON.stringify(r))) {
      return { id: p.id, verdict: 'error', error: 'pack_untrusted in the run — red for the wrong reason (trust, not the sabotage)' };
    }
    const red = r.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
    const suiteError = r.testResults.filter((t) => t.status === 'failed' && t.assertionResults.length === 0).map((t) => (t.message ?? '').slice(0, 200));
    let verdict;
    if (red.length === 0 && suiteError.length === 0) verdict = 'vacuous';
    else if (!p.expect_red?.length) verdict = 'witnessed';
    else verdict = p.expect_red.every((s) => red.some((t) => t.includes(s))) ? 'witnessed' : 'other-red';
    return { id: p.id, verdict, red, ...(suiteError.length ? { suiteError } : {}), total: r.numTotalTests };
  } finally {
    restore(p.src, srcAbs, text);
  }
}

// A restore that is not verified is not a restore. `git checkout` alone failed
// silently once (a peer held index.lock in the same worktree): the sabotage stayed
// in place and every later probe on that file refused it as "src already dirty".
function restore(src, srcAbs, text) {
  writeFileSync(srcAbs, text);
  if (git('diff', '--quiet', '--', src).status !== 0) git('checkout', '--', src);
  if (git('diff', '--quiet', '--', src).status !== 0) {
    console.error(`✗ test-probe: could not restore ${src} — stopping; fix it by hand before re-running`);
    process.exit(2);
  }
}

for (const p of probes) console.log(JSON.stringify(runProbe(p)));
const status = execFileSync('git', ['status', '--porcelain', '--', ...new Set(probes.map((p) => p.src))], { cwd: ROOT, encoding: 'utf8' }).trim();
console.log(`PROBED_SRC_STATUS: ${status || 'clean'}`);
if (status) process.exitCode = 1;
