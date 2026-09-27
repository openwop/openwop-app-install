/**
 * Deploy provenance (ADR 0518) — which COMMIT is this process running?
 *
 * WHY THIS EXISTS. Nothing in the running app could answer that question.
 * `/.well-known/openwop` reports a hand-maintained `version: "0.1.0"` that has
 * not moved in the app's lifetime, and `/health` returns `{status:"ok"}`. So
 * "is production running the code I merged?" had no cheap answer, and on
 * 2026-08-03 that cost real time: two sessions deployed within minutes of each
 * other from different sources, and the second silently reverted the first.
 * Prod briefly served a new SPA against a backend without the route it called.
 *
 * The failure mode that makes this worth a module rather than a log line: the
 * obvious check — compare the built asset hash to the served one — SAYS YES for
 * a clobbering deploy, because that deploy's own hashes are internally
 * consistent. Detecting it actually required downloading a served code-split
 * chunk and grepping for a string only the new code contained. That is not a
 * check anyone runs routinely, so in practice the regression was invisible.
 *
 * HONESTY RULE. When the stamp is absent this reports `'unknown'` and NEVER
 * guesses — not the package version, not a timestamp. A confident wrong commit
 * is worse than no commit: it would make the verification script pass while
 * lying, which is the exact class of defect this module exists to expose.
 *
 * ── CORRECTION 2026-08-10: the honesty rule was enforced against the UNLIKELY
 * failure and blind to the LIKELY one. ──────────────────────────────────────
 *
 * The original implementation read `OPENWOP_BUILD_COMMIT` and validated its
 * SHAPE (a 7–40 char hex SHA), reporting `unknown` for anything malformed. It
 * had no defense against a well-formed SHA that was simply STALE — and stale
 * was not an edge case, it was the DEFAULT outcome of the documented deploy
 * path. `OPENWOP_BUILD_COMMIT` is set on the SERVICE, so it is deploy CONFIG,
 * not part of the artifact; a bare `gcloud run deploy` (correct — passing no
 * `--set-*` is what preserves the live secret + env binding) PRESERVES it.
 *
 * Measured: on 2026-08-10 revision 00631 ran `e65ff6888` while `/api/readiness`
 * reported `{commit: "43b539ed2…", stamped: true}` — the previous deploy's
 * commit, wearing a truthy freshness flag. The module could only fail in the
 * direction its own docblock calls worse.
 *
 * THE FIX: prefer a commit baked into the IMAGE (`build-meta/commit.txt`,
 * written by `scripts/write-build-commit.mjs`, COPYed by the Dockerfile). The
 * image is the only artifact 1:1 with the code — a code change always builds a
 * new image, and a config-only `--update-env-vars` reuses it, which is correct
 * because the code did not change. The env var remains as a fallback (it is the
 * only mechanism a hand-deploy has, and the hand path must keep working: it is
 * the emergency route when `scripts/deploy.env` is absent), but it is now
 * reported as `commitSource: 'env'` — a CLAIM, not corroborated provenance.
 *
 * WHAT THIS STILL DOES NOT DO — three bounded gaps, stated because an earlier
 * draft of this comment overstated all three:
 *
 * 1. `commitSource: 'image'` proves the SHA travelled with the artifact, NOT
 *    that it describes the source that built it. A wrong value passed to
 *    `write-build-commit.mjs` is baked in faithfully.
 *
 * 2. Forgetting the writer does NOT reliably yield a loud `unknown`. That holds
 *    only in a FRESH checkout. `build-meta/commit.txt` is gitignored, so it
 *    PERSISTS in a reused deploy tree (`/tmp/owp-deploy` is exactly that) — and
 *    a hand-deploy that skips the writer then bakes the PREVIOUS deploy's SHA,
 *    which is the original defect relocated from config to a file. `git status`
 *    cannot see it (ignored files are not dirty) and no unit test can (they
 *    point at a temp dir via `OPENWOP_BUILD_META_DIR`). That path is closed by
 *    `scripts/preflight-deploy.sh` Gate 4, which fails when the stamp is absent
 *    or does not equal HEAD — NOT by this module.
 *
 * 3. The env var can no longer CORRECT a bad image stamp. Before this change,
 *    `--update-env-vars` could fix provenance without a rebuild; now the image
 *    wins, so a wrong baked SHA requires a new image. That is the deliberate
 *    cost of making the artifact authoritative — the env var remains a fallback
 *    for ABSENCE (the hand path, and images built before this change), not an
 *    override.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoDir } from './_repoPath.js';

/**
 * A 40-hex SHA or a short prefix. Anything else (a branch name, a CI
 * placeholder that never interpolated, an empty string) is NOT provenance and
 * is reported as unknown rather than echoed back as if it were.
 */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Where the commit came from. `'env'` is a deploy-time CLAIM, not corroborated. */
export type CommitSource = 'image' | 'env' | 'none';

/**
 * Read `<dir>/commit.txt`. Exported so the filesystem half is testable against a
 * real temp directory — a pure-logic test alone would not prove the read works,
 * and this module has already shipped one defect that only a real read exposes.
 */
export function readImageCommit(dir: string): string | null {
  try {
    const file = join(dir, 'commit.txt');
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8').trim();
    return SHA_RE.test(raw) ? raw : null;
  } catch {
    // An unreadable file is not provenance. Fall through to the env claim
    // rather than crash a readiness probe on a permissions error.
    return null;
  }
}

/**
 * RFC 0146 `contractProvenance.suiteVersion` — which corpus revision this
 * host's contract handling corresponds to.
 *
 * Read from the SAME image stamp as the commit, and for the same reason:
 * `@openwop/openwop-conformance` is a devDependency and the release stage runs
 * `npm ci --omit=dev`, so resolving it at runtime would omit the field in
 * production — the one place a staleness signal is worth anything.
 *
 * Returns null when unstamped, and the caller OMITS the field rather than
 * substituting a guess. RFC 0146 requirement 1: absent ⇒ *unspecified*, not
 * "current" and not "stale"; requirement 2 makes advertising a revision you do
 * not implement a false statement. Omission is the honest answer, and it is the
 * same discipline as withdrawing `recorded-outcome` rather than keeping a claim
 * that had outrun its evidence.
 */
export function readImageCorpusSuite(dir: string): string | null {
  try {
    const file = join(dir, 'corpus-suite.txt');
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8').trim();
    // Requirement 4: a PUBLISHED conformance version and nothing else. A vendor
    // build identifier belongs in `implementation`, which already exists for it.
    return /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The stamped suite version, or null. Same resolver + seam as the commit. */
export function contractProvenanceSuiteVersion(): string | null {
  const override = process.env.OPENWOP_BUILD_META_DIR?.trim();
  if (override) return readImageCorpusSuite(override);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readImageCorpusSuite(locateRepoDir(here, 'build-meta', '.gitkeep'));
  } catch {
    return null;
  }
}

/**
 * Locate the image's `build-meta/` directory, or null when absent (a source
 * tree that never ran the writer, or an image built before this change).
 * `OPENWOP_BUILD_META_DIR` overrides the walk — a test seam, and an escape
 * hatch for a layout this resolver does not anticipate.
 */
function imageCommit(): string | null {
  // DELIBERATELY NOT MEMOISED. `/health` and `/api/readiness` call this and are
  // hit by uptime probes, so caching looks like an obvious win — it is not worth
  // it here. In the image the walk terminates on the SECOND step (`/app/lib` →
  // `/app/build-meta`), i.e. two `existsSync` calls, and memoising would freeze
  // the `OPENWOP_BUILD_META_DIR` seam at first call and silently break the tests
  // that vary it per case. Measure before changing this.
  const override = process.env.OPENWOP_BUILD_META_DIR?.trim();
  if (override) return readImageCommit(override);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readImageCommit(locateRepoDir(here, 'build-meta', '.gitkeep'));
  } catch {
    // locateRepoDir throws when the walk hits the filesystem root. That is a
    // normal state here (unlike its schema/pack callers, where absence is
    // fatal), so it is caught rather than propagated.
    return null;
  }
}

/**
 * Resolve provenance from the two candidate sources. Pure — the precedence rule
 * is the part most worth testing, and keeping it free of I/O means a test can
 * assert it without staging a filesystem.
 *
 * Image WINS over env: the image travels with the code, the env var travels
 * with the config, and it is precisely their disagreement that signals an
 * inherited stamp.
 */
export function resolveBuildProvenance(
  imageRaw: string | null,
  envRaw: string | undefined,
): { commit: string; commitSource: CommitSource } {
  if (imageRaw && SHA_RE.test(imageRaw)) return { commit: imageRaw, commitSource: 'image' };
  const env = envRaw?.trim();
  if (env && SHA_RE.test(env)) return { commit: env, commitSource: 'env' };
  return { commit: 'unknown', commitSource: 'none' };
}

/** Git commit SHA this image was deployed from, or `'unknown'` if unstamped. */
export function buildCommit(): string {
  return resolveBuildProvenance(imageCommit(), process.env.OPENWOP_BUILD_COMMIT).commit;
}

/** When the deploy stamped this image, or `null`. Informational only. */
export function buildDeployedAt(): string | null {
  const raw = process.env.OPENWOP_BUILD_DEPLOYED_AT?.trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface BuildInfo {
  commit: string;
  deployedAt: string | null;
  /**
   * False when the deploy did not stamp a commit — the verify script fails on this.
   *
   * NOTE this field is deliberately UNCHANGED in name and type: `verify-deploy.sh`
   * and operator scripts read it. It answers "is there a commit at all?", NOT
   * "does that commit describe this code" — the two were conflated until
   * 2026-08-10. Read `commitSource` for the second question.
   */
  stamped: boolean;
  /**
   * Where `commit` came from. `'image'` travelled with the artifact; `'env'` is a
   * deploy-time claim that a bare redeploy can silently carry over from the
   * PREVIOUS deploy; `'none'` means unstamped.
   */
  commitSource: CommitSource;
}

export function buildInfo(): BuildInfo {
  const { commit, commitSource } = resolveBuildProvenance(
    imageCommit(),
    process.env.OPENWOP_BUILD_COMMIT,
  );
  return { commit, deployedAt: buildDeployedAt(), stamped: commit !== 'unknown', commitSource };
}
