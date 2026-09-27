#!/usr/bin/env node
/**
 * Write the build commit into `build-meta/commit.txt` so it can be COPYed into
 * the Cloud Run image (ADR 0518 correction, 2026-08-10).
 *
 * WHY A FILE AND NOT THE ENV VAR. `OPENWOP_BUILD_COMMIT` is set on the SERVICE,
 * so it is part of the deploy CONFIG rather than the artifact. A bare
 * `gcloud run deploy` — which is the correct invocation, because passing no
 * `--set-*` is what preserves the live secret + env binding — therefore
 * PRESERVES the previous deploy's commit. The new revision then runs new code
 * while `/api/readiness` reports the old SHA with `stamped: true`.
 *
 * Measured on 2026-08-10: revision 00631 ran `e65ff6888` and reported
 * `43b539ed2`. `buildInfo.ts` validated the SHA's SHAPE and had no way to know
 * it did not describe the running code.
 *
 * A file inside the image cannot drift that way: a code change always produces
 * a new image, and a config-only update (`--update-env-vars`) reuses the image
 * — which is correct, because the code did not change.
 *
 * THE FAILURE MODE THIS TRADES FOR — and its limit. In a FRESH checkout,
 * forgetting to run this yields an ABSENT file, which `buildInfo.ts` reports as
 * `unknown` and `scripts/verify-deploy.sh` hard-fails: a silent wrong answer
 * becomes a loud missing one, and `buildInfo.ts`'s honesty rule ranks `unknown`
 * above a confident wrong value.
 *
 * In a REUSED deploy checkout that does NOT hold, and the difference matters.
 * The output is gitignored, so it survives between deploys; skipping this script
 * there uploads the PREVIOUS deploy's SHA and bakes it in — the original defect,
 * moved from config to a file. `scripts/preflight-deploy.sh` Gate 4 is the thing
 * that catches it (stamp absent, or != HEAD). This script cannot self-detect it.
 *
 * The output is GITIGNORED on purpose — `scripts/preflight-deploy.sh` refuses a
 * dirty tree via `git status --porcelain`, which does not list ignored files.
 * A tracked generated file would make every deploy trip its own preflight.
 *
 * Usage:
 *   node scripts/write-build-commit.mjs            # SHA from git HEAD
 *   node scripts/write-build-commit.mjs <sha>      # explicit (deploy.sh passes its own)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build-meta');
const OUT_FILE = join(OUT_DIR, 'commit.txt');

/** Same shape gate `buildInfo.ts` applies. A value that fails it is not provenance. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const sha = (process.argv[2] ?? gitHead() ?? '').trim();

// Refuse rather than write a value the reader will reject anyway. Writing
// garbage here would produce `unknown` at runtime with no hint of why, and the
// operator would be debugging the wrong layer.
if (!SHA_RE.test(sha)) {
  console.error(
    `write-build-commit: refusing to write ${sha ? `"${sha}"` : 'an empty value'} — ` +
      'not a git SHA. Pass one explicitly, or run inside a git checkout.',
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, `${sha}\n`, 'utf8');
console.log(`✓ write-build-commit: build-meta/commit.txt → ${sha.slice(0, 12)}`);

// ── RFC 0146 `contractProvenance.suiteVersion` ─────────────────────────────
// Which corpus revision this host's contract handling corresponds to. Stamped
// HERE, at build, for a reason: `@openwop/openwop-conformance` is a
// devDependency and the release stage runs `npm ci --omit=dev`, so the package
// is NOT resolvable at runtime. Reading it lazily would omit the field in
// production — the one place a staleness signal is worth anything.
//
// DERIVED, never a constant. RFC 0146 guidance G2: requirement 2 is a
// self-report nothing outside can witness, and the fix is to derive the value
// from the installed package so the claim is "structurally true instead of
// merely asserted". A hand-written version here would be a second place to
// update and would drift toward agreeing with itself — the same failure the
// §A adverts and `check-wire-claims.mjs` are built to avoid.
//
// Absent is LEGITIMATE (requirement 1: absent ⇒ unspecified, not "current" and
// not "stale"), so a source checkout without the devDependency simply omits it
// rather than guessing.
try {
  // Resolve from the WORKSPACE that declares the dependency, not from
  // `scripts/` — `import.meta.url` here is the script, whose directory has no
  // node_modules, so the lookup fails and the field is silently omitted.
  const req = createRequire(join(OUT_DIR, '..', 'backend', 'typescript', 'package.json'));
  const v = req('@openwop/openwop-conformance/package.json').version;
  // Requirement 4: this field takes a PUBLISHED conformance version and nothing
  // else — a vendor build id belongs in `implementation`.
  if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) {
    writeFileSync(join(OUT_DIR, 'corpus-suite.txt'), `${v}\n`, 'utf8');
    console.log(`✓ write-build-commit: build-meta/corpus-suite.txt → ${v}`);
  } else {
    dropStaleCorpusSuite('conformance version unreadable');
  }
} catch {
  dropStaleCorpusSuite('@openwop/openwop-conformance not installed');
}

// H42 (2026-08-17). "Omitting" used to mean "leave whatever is there" — and a
// long-lived checkout carries the gitignored `corpus-suite.txt` from whatever
// deploy last derived it. `.gcloudignore` deliberately un-ignores
// `build-meta/**`, so that stale file rode into a peer's upload and prod
// advertised `contractProvenance.suiteVersion: "1.66.0"` while the pin was
// 1.135.0 — a false RFC 0146 claim (requirement 2), on the same commit another
// deploy stamped honestly-absent minutes earlier (`gcloud builds list` showed
// both). If this script cannot DERIVE the value NOW, it must not let an OLD
// derivation ship: delete it, and say so. Absent ⇒ unspecified (requirement 1);
// stale ⇒ false. Only the first is honest.
function dropStaleCorpusSuite(why) {
  const stale = join(OUT_DIR, 'corpus-suite.txt');
  if (existsSync(stale)) {
    const old = readFileSync(stale, 'utf8').trim();
    rmSync(stale, { force: true });
    console.warn(`write-build-commit: ${why} — REMOVED stale build-meta/corpus-suite.txt (was ${old}); contractProvenance will be ABSENT, not stale`);
  } else {
    console.warn(`write-build-commit: ${why} — omitting contractProvenance (absent ⇒ unspecified)`);
  }
}

// ── ADR 0550 P4 — the certification stamp this script CANNOT derive ─────────
//
// `build-meta/certification-bundle.json` + `conformance-claims.json` are the
// evidence behind a PUBLIC profile claim, and they can only be produced by
// actually running the conformance suite against a booted host
// (`npm run test:conformance -- --certify`). Nothing here can re-derive them.
//
// Which makes them the H42 hazard in its sharpest form. The files are
// gitignored, so a long-lived deploy checkout keeps whatever the last certify
// wrote — and `.gcloudignore` deliberately un-ignores `build-meta/**`, so they
// ride into the upload. A deploy from that checkout would ship a bundle
// describing a DIFFERENT commit's behaviour, advertise the RFC 0089 §D pointer
// at it, and look completely healthy: the commit stamp matches HEAD, and
// `verify-deploy.sh` checks the commit, which was never the claim. That is the
// `1.66.0` incident with a public conformance claim in place of a version
// string.
//
// So: the same rule as above, applied without the escape hatch that rule has.
// `corpus-suite.txt` can be re-derived here, so absence is a fallback. These
// cannot, so DELETION IS THE ONLY HONEST ACTION — every run of this script
// removes them, and `scripts/deploy.sh` re-produces them with a real certify
// run (or ships without, deliberately, via `--skip-certify`). Absent ⇒ this
// build publishes no claim, which is fully conformant per RFC 0089 §D. Stale ⇒
// this build publishes someone else's evidence as its own.
for (const f of ['certification-bundle.json', 'conformance-claims.json']) {
  const stale = join(OUT_DIR, f);
  if (!existsSync(stale)) continue;
  rmSync(stale, { force: true });
  console.warn(
    `write-build-commit: REMOVED build-meta/${f} — a certification stamp cannot be re-derived here, ` +
      'and a stale one publishes another commit\'s evidence. `scripts/deploy.sh` re-runs --certify; ' +
      'without that the RFC 0089 §D pointer ships ABSENT, which is honest.',
  );
}
