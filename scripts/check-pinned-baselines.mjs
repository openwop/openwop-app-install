#!/usr/bin/env node
/**
 * ADR 0863 D9 — every `-pinned` visual baseline (the remote gate VM's) must have been
 * rendered beside the `-darwin` baseline it twins (the Macs'). The two sets are recorded
 * by different tools: `--update-snapshots` on a Mac writes `-darwin`, and only
 * scripts/e2e-pinned-baselines.sh writes `-pinned`. On 2026-11-07 two commits re-recorded
 * four `-darwin` images and not their twins, so the VM's required visual tests went red
 * (shadow 14) on code the Macs passed. With the remote gate first, that red is final for
 * the whole train.
 *
 * The generator records each darwin image's sha256 in frontend/react/e2e/
 * pinned-baselines.lock.json. This check fails when a darwin image no longer matches
 * its entry (re-baselined alone), when a twin or an entry is missing, or when an entry
 * names no image. Tree-only and fast, so it runs in ci:quick: the author learns at
 * authoring time, not in a VM train.
 *
 *   node scripts/check-pinned-baselines.mjs [--root <repo>]           check
 *   node scripts/check-pinned-baselines.mjs [--root <repo>] --write   rewrite the lock (the generator, after a clean recording)
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--root');
const ROOT = at >= 0 ? resolve(args[at + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = args.includes('--write');
const E2E = join(ROOT, 'frontend/react/e2e');
const LOCK = join(E2E, 'pinned-baselines.lock.json');
const REMEDY = 'Re-run scripts/e2e-pinned-baselines.sh (Docker; see its header) and commit the -pinned images and the lock with the -darwin ones.';

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const pairs = new Map(); // "<dir>/<name>-chromium" -> { darwin, pinned }
for (const d of readdirSync(E2E).filter((n) => n.endsWith('-snapshots')).sort()) {
  for (const f of readdirSync(join(E2E, d))) {
    const m = /^(.*)-(darwin|pinned)\.png$/.exec(f);
    if (!m) continue;
    const key = `${d}/${m[1]}`;
    pairs.set(key, { ...pairs.get(key), [m[2]]: join(E2E, d, f) });
  }
}
const doc = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : { version: 1 };
if (WRITE) {
  const darwin = {};
  for (const [key, p] of [...pairs].sort()) if (p.darwin && p.pinned) darwin[key] = sha(p.darwin);
  writeFileSync(LOCK, `${JSON.stringify({ ...doc, darwin }, null, 2)}\n`);
  console.log(`  wrote ${Object.keys(darwin).length} pairs to e2e/pinned-baselines.lock.json`);
}
const lock = WRITE ? JSON.parse(readFileSync(LOCK, 'utf8')).darwin : doc.darwin ?? {};

const problems = [];
for (const [key, p] of [...pairs].sort()) {
  if (!p.darwin) problems.push(`${key}: has a -pinned image but no -darwin twin`);
  else if (!p.pinned) problems.push(`${key}: has a -darwin image but no -pinned twin`);
  else if (!lock[key]) problems.push(`${key}: not in pinned-baselines.lock.json`);
  else if (lock[key] !== sha(p.darwin)) problems.push(`${key}: the -darwin image changed after its -pinned twin was rendered`);
}
for (const key of Object.keys(lock).sort()) if (!pairs.has(key)) problems.push(`${key}: lock entry names no image`);

if (problems.length) {
  console.error(`✗ check-pinned-baselines: ${problems.length} problem(s)\n  ${problems.join('\n  ')}\n  ${REMEDY}`);
  process.exit(1);
}
console.log(`✓ check-pinned-baselines: ${pairs.size} -darwin/-pinned pairs, each -pinned rendered beside its -darwin image`);
