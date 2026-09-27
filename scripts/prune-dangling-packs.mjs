#!/usr/bin/env node
/**
 * Remove `~/.openwop-packs` symlinks whose source checkout no longer exists.
 *
 * ── WHY THIS EXISTS AS A SCRIPT ────────────────────────────────────────────
 * `ensureLocalPacksMounted` already prunes these — but only on the NEXT backend
 * boot. The damage happens at `git worktree remove`, and git has **no**
 * post-worktree-remove hook to attach to, so there is a window between the two
 * in which the pack namespace is broken and nothing has run.
 *
 * That window is not theoretical: it fired **three times in one session**
 * (2026-08-06/07), each time leaving all ~174 repo-vendored symlinks dangling,
 * because the removed worktree was the last one to mount packs.
 *
 * ── WHAT A DANGLING MOUNT COSTS ────────────────────────────────────────────
 * Not a missing pack — a LYING one. The namespace still lists it, so any
 * non-vitest boot (`npm run dev`, `scripts/e2e-routes.sh`, a manual
 * `node lib/index.js`) fails against a path that no longer exists, which reads
 * as a corrupt install rather than a stale link. Backend vitest is unaffected:
 * `test/setup/isolatePackDir.ts` gives each worker its own dir — which is
 * exactly why this class never turns a test red.
 *
 * A dangling symlink resolves to nothing, so removing one cannot lose data.
 * Real directories (registry-installed, signed packs) are never touched.
 *
 * ── WHY THIS DUPLICATES `mountLocalPacks.ts` RATHER THAN IMPORTING IT ──────
 * Two implementations of one rule is this repo's favourite drift generator, so
 * the duplication is a decision, not an oversight.
 *
 * Importing the mount's helper would make a plain `node scripts/…` invocation
 * depend on the backend's TypeScript BUILD — so the tool you reach for when the
 * pack namespace is broken would itself require a working build to run. That is
 * strictly worse than restating four lines of `lstat`/`existsSync`.
 *
 * The shared rule is one line and is asserted in BOTH places:
 *   a symlink whose target does not resolve is dangling; everything else is not.
 * `backend/typescript/test/mount-local-packs-prune.test.ts` pins the mount's
 * copy; the same three cases (dangling link / live link / real directory) are
 * the ones this script is probed against.
 *
 * Usage:
 *   node scripts/prune-dangling-packs.mjs           # prune, report
 *   node scripts/prune-dangling-packs.mjs --check   # report only, exit 1 if any
 */
import { readdirSync, lstatSync, existsSync, rmSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CHECK_ONLY = process.argv.includes('--check');
const DIR = process.env.OPENWOP_PACK_DIR ?? join(homedir(), '.openwop-packs');

if (!existsSync(DIR)) {
  console.log(`prune-dangling-packs: no pack dir at ${DIR} — nothing to do.`);
  process.exit(0);
}

const dangling = [];
let symlinks = 0;
let realDirs = 0;

for (const entry of readdirSync(DIR)) {
  const p = join(DIR, entry);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    continue;
  }
  if (!st.isSymbolicLink()) {
    realDirs += 1;
    continue;
  }
  symlinks += 1;
  // `existsSync` FOLLOWS the link, so false here means the target is gone.
  if (!existsSync(p)) {
    let target = '<unreadable>';
    try {
      target = readlinkSync(p);
    } catch { /* keep the placeholder */ }
    dangling.push({ entry, target });
  }
}

if (dangling.length === 0) {
  console.log(
    `✓ prune-dangling-packs: ${symlinks} symlink(s) all resolve; ${realDirs} registry dir(s) untouched.`,
  );
  process.exit(0);
}

// Group by the checkout that vanished — one removed worktree typically accounts
// for all of them, and saying so is more useful than 174 near-identical lines.
const byTarget = new Map();
for (const d of dangling) {
  const root = d.target.split('/packs/')[0] ?? d.target;
  byTarget.set(root, (byTarget.get(root) ?? 0) + 1);
}

console.error(`${CHECK_ONLY ? '✗' : '⚠'} ${dangling.length} dangling pack symlink(s) in ${DIR}:`);
for (const [root, n] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) {
  console.error(`    ${n.toString().padStart(4)} → ${root} (gone)`);
}

if (CHECK_ONLY) {
  console.error('\n  Run `node scripts/prune-dangling-packs.mjs` to remove them.');
  process.exit(1);
}

let removed = 0;
for (const d of dangling) {
  try {
    rmSync(join(DIR, d.entry), { force: true });
    removed += 1;
  } catch (err) {
    console.error(`  failed to remove ${d.entry}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(
  `✓ removed ${removed} dangling symlink(s). ${realDirs} registry dir(s) untouched. `
  + 'The next backend boot from a current checkout re-mounts this repo\'s packs.',
);
