#!/usr/bin/env node
/**
 * Emit `dist/build-info.json` — deploy provenance for the SPA half (ADR 0518).
 *
 * WHY. Verifying a frontend deploy meant comparing the local `dist/assets/index-*.js`
 * hash to the served one. That check PASSES for a deploy that clobbered yours,
 * because the clobbering build's hashes are internally consistent — which is
 * exactly what happened on 2026-08-03 and went unnoticed until a served
 * code-split chunk was downloaded and grepped for a string only the new code
 * contained. A hash proves "these bytes were built together"; it does not prove
 * WHICH SOURCE they were built from. The commit does.
 *
 * The commit is read from `OPENWOP_BUILD_COMMIT` when set (the deploy path), else
 * from git (a local build). If neither answers, `commit` is `"unknown"` and
 * `stamped` is false — never a guess, matching `host/buildInfo.ts`'s honesty rule.
 *
 * Runs AFTER `vite build`, so it lands in the same `dist/` the deploy uploads.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

function fromEnv() {
  const raw = process.env.OPENWOP_BUILD_COMMIT?.trim();
  return raw && /^[0-9a-f]{7,40}$/i.test(raw) ? raw : null;
}

function fromGit() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    // No git in the build image, or not a repo. Not an error — just unknown.
    return null;
  }
}

const commit = fromEnv() ?? fromGit() ?? 'unknown';

// A local build of a DIRTY tree is not the commit it claims. Say so, so nobody
// verifies a deploy against a SHA that never contained what they shipped.
let dirty = false;
try {
  dirty = execFileSync('git', ['status', '--porcelain'], { cwd: here, encoding: 'utf8' }).trim().length > 0;
} catch { /* unknown-git — leave false; `stamped` already carries the caveat */ }

if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

const info = {
  commit,
  stamped: commit !== 'unknown',
  dirty,
  builtAt: new Date().toISOString(),
};
writeFileSync(join(dist, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);

const label = info.stamped ? `${commit.slice(0, 12)}${dirty ? ' (DIRTY TREE)' : ''}` : 'unknown (unstamped)';
console.log(`✓ write-build-info: dist/build-info.json → ${label}`);
