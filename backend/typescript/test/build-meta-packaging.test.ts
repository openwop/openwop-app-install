/**
 * Packaging tripwires for the image-baked build stamp (ADR 0518 correction).
 *
 * WHY THESE EXIST — a defect caught pre-merge on 2026-08-10 that NO unit test
 * could have seen. `build-meta/commit.txt` is gitignored on purpose (so
 * `scripts/preflight-deploy.sh`, which refuses a dirty tree via `git status
 * --porcelain`, does not trip on a file every deploy regenerates). But
 * `.gcloudignore` is `#!include:.gitignore`, so gitignored ALSO meant
 * NOT-UPLOADED: `gcloud meta list-files-for-upload` listed `.gitkeep` and
 * omitted `commit.txt` while the file sat on disk. The Dockerfile's
 * `COPY build-meta` would have landed an empty directory and every image would
 * have reported `commit: unknown` — silently, forever.
 *
 * It was test-invisible because the provenance unit tests point at a temp dir
 * via `OPENWOP_BUILD_META_DIR`; they pass whether or not the real file ever
 * ships. These tests assert the PACKAGING contract instead of the logic, which
 * is the only layer where that class of defect is observable without Docker.
 *
 * These are static-consistency checks by necessity: CI has no Docker daemon and
 * no gcloud credentials, so neither `docker build` nor a real upload-set diff is
 * runnable here. They pin the three declarations that must agree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { locateRepoDir } from '../src/host/_repoPath.js';
import { readImageCommit } from '../src/host/buildInfo.js';

const REPO = resolve(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('build-meta packaging contract', () => {
  it('the sentinel `.gitkeep` exists — a clean clone must still have the dir for COPY', () => {
    // Docker COPY fails the image build when its source path is absent, and
    // commit.txt is gitignored, so .gitkeep is the only thing holding the
    // directory open in a fresh checkout.
    expect(existsSync(join(REPO, 'build-meta', '.gitkeep'))).toBe(true);
  });

  it('the Dockerfile COPYs the directory, not the (gitignored) file', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/^COPY build-meta \.\/build-meta$/m);
    // COPYing the file directly would fail the build on a clean clone.
    expect(dockerfile).not.toMatch(/COPY build-meta\/commit\.txt/);
  });

  it('THE TRIPWIRE: EVERY gitignored stamp needs a .gcloudignore negation, or it never uploads', () => {
    // GENERALIZED 2026-08-15, after this assertion passed through the exact
    // defect it describes. It pinned `commit.txt` by name. RFC 0146 added a
    // second stamp — `build-meta/corpus-suite.txt` — which was gitignored for
    // the same good reason, inherited `#!include:.gitignore`, and was dropped
    // from the upload. `contractProvenance` deployed ABSENT a second time,
    // while this test stayed green, `verify-deploy.sh` passed, and the commit
    // stamp matched HEAD. Measured with `gcloud meta list-files-for-upload`:
    // the file was on disk and not in the upload set.
    //
    // The lesson is the one this program keeps relearning: a tripwire written
    // against an INSTANCE does not cover the CLASS, and it looks identical
    // while not covering it. So the stamp list is DERIVED FROM THE WRITER
    // rather than re-typed here — a second hand-kept list would reproduce the
    // failure one level up.
    const gitignore = read('.gitignore');
    const gcloudignore = read('.gcloudignore');
    const writer = read('scripts/write-build-commit.mjs');

    const stamps = [...new Set([...writer.matchAll(/join\(\s*OUT_DIR\s*,\s*'([^']+)'\s*\)/g)].map((m) => m[1]))];
    // Vacuity guard: a regex that stops matching would make this test pass by
    // finding nothing to check — the failure mode being fixed, re-entering
    // through the fix.
    expect(
      stamps.length,
      'parsed NO stamp filenames out of scripts/write-build-commit.mjs — the writer changed shape. '
        + 'Fix this parse rather than letting the check silently cover nothing.',
    ).toBeGreaterThanOrEqual(2);
    expect(stamps).toContain('commit.txt');
    expect(stamps).toContain('corpus-suite.txt');

    const gcloudIncludesGitignore = /^#!include:\.gitignore$/m.test(gcloudignore);
    if (!gcloudIncludesGitignore) return; // no inheritance ⇒ no hazard

    const lines = gcloudignore.split('\n').map((l) => l.trim());
    const includeAt = lines.indexOf('#!include:.gitignore');

    for (const stamp of stamps) {
      const gitIgnoresIt = new RegExp(`^build-meta/${stamp.replace('.', '\\.')}$`, 'm').test(gitignore);
      if (!gitIgnoresIt) continue; // tracked ⇒ uploads normally

      // Either the exact-file negation or the directory-wide form covers it.
      // `!build-meta/**` is the preferred shape precisely because it covers the
      // NEXT stamp too, but both are correct and the check accepts either.
      const negationAt = lines.findIndex(
        (l) => l === `!build-meta/${stamp}` || l === '!build-meta/**' || l === '!build-meta/*',
      );
      expect(
        negationAt,
        `build-meta/${stamp} is gitignored and .gcloudignore includes .gitignore, so it is `
          + 'EXCLUDED from the Cloud Build upload. The image carries a build-meta/ without it and '
          + 'the value it feeds reports as absent — which for RFC 0146 `contractProvenance` is a '
          + 'LEGITIMATE state, so nothing downstream can tell the difference. Add `!build-meta/**` '
          + 'to .gcloudignore (below the include).',
      ).toBeGreaterThan(-1);

      // ORDER IS LOAD-BEARING, and asserting mere presence would not catch a
      // reorder. gitignore semantics are last-match-wins, so a negation placed
      // ABOVE `#!include:.gitignore` is overridden by the include and the file
      // silently drops out of the upload again. MEASURED 2026-08-10 with
      // `gcloud meta list-files-for-upload`: negation after the include → the
      // file is listed; before it → it is not.
      expect(
        negationAt,
        `The negation covering build-meta/${stamp} must come AFTER `
          + '`#!include:.gitignore` (last match wins). Above it, the include re-ignores the file '
          + 'and the upload drops it.',
      ).toBeGreaterThan(includeAt);
    }
  });

  it('THE SAME TRIPWIRE FOR .dockerignore — the third ignore-file in this class (ADR 0550 P2)', () => {
    // A `.dockerignore` was added 2026-08-13 for the ADR 0550 P2 container
    // conformance lane: without one the build context is ~549M, of which
    // backend/typescript/node_modules alone is 453M (the image never copies it —
    // it runs `npm ci` from the lockfile). Measured after: 412.72kB.
    //
    // That makes it the third file that can silently un-ship the build stamp,
    // alongside .gitignore and .gcloudignore. Unlike .gcloudignore it has NO
    // `#!include:.gitignore` mechanism, so the danger is not inheritance — it is
    // someone later adding a plausible-looking exclusion.
    //
    // MEASURED, both sabotages, because only one of them is dangerous:
    //   exclude `build-meta`            → docker build FAILS (rc=1). Loud, harmless.
    //   exclude `build-meta/commit.txt` → build SUCCEEDS (rc=0) and the image
    //                                     reports commit: unknown.
    // The second is what a .gitignore-derived list produces: .gitignore ignores
    // commit.txt but NOT the tracked .gitkeep beside it, so the directory still
    // ships and `COPY build-meta` is satisfied by an empty dir. A green build
    // that produced an unidentifiable artifact — and ADR 0518 treats `unknown`
    // as a failed deploy precisely because it is indistinguishable from stale.
    if (!existsSync(join(REPO, '.dockerignore'))) return; // not yet added — nothing to pin
    const dockerignore = read('.dockerignore');

    // Deliberately NOT a general .dockerignore pattern engine. Implementing one
    // by hand would be a self-authored matcher asserting its own semantics —
    // the exact shape that produced a false finding earlier in this program.
    // This checks the literal forms a person actually writes for this path.
    const offenders = dockerignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'))
      // Widened 2026-08-15 alongside the .gcloudignore generalization: this
      // listed `commit.txt` by name, so an exclusion naming any OTHER stamp
      // (`corpus-suite.txt`) would have passed straight through. Matches any
      // single file under build-meta/ rather than one filename.
      .filter((l) => /^(\*\*\/)?build-meta(\/([A-Za-z0-9._-]+|\*|\*\*))?$/.test(l));

    expect(
      offenders,
      `.dockerignore excludes the build stamp (${offenders.join(', ')}). Excluding the FILE is `
        + 'the dangerous case: the build still succeeds because the tracked .gitkeep keeps the '
        + 'directory alive, and every image then reports commit: unknown. Remove the line — do '
        + 'not "fix" it with a negation, because nothing here includes .gitignore in the first place.',
    ).toEqual([]);
  });

  it('the repository history is NOT build input — `.gcloudignore` excludes `.git`', () => {
    // MEASURED 2026-08-15 in the shared checkout: 5,479 of 14,529 uploaded
    // files (38%, ~172 MB) were `.git/` internals. `.gitignore` does not list
    // `.git`, and `#!include:.gitignore` is the only source of exclusions, so
    // without an explicit line every deploy ships the object store.
    //
    // WHY A TEST AND NOT JUST THE LINE: this is invisible from a git WORKTREE,
    // which is the recommended way to deploy — there `.git` is a ~69-byte
    // pointer file, so `gcloud meta list-files-for-upload` looks clean. The
    // defect can only be observed from the deploy path we tell people NOT to
    // use, which is precisely how it survived unnoticed.
    const gcloudignore = read('.gcloudignore');
    const lines = gcloudignore.split('\n').map((l) => l.trim());
    const includeAt = lines.indexOf('#!include:.gitignore');
    const gitAt = lines.findIndex((l) => l === '.git' || l === '.git/' || l === '**/.git');
    expect(
      gitAt,
      '.gcloudignore does not exclude `.git`, so every deploy from a normal checkout uploads the '
        + 'entire repository history to Cloud Build (measured: 38% of the upload). Add `.git` below '
        + 'the `#!include:.gitignore` line.',
    ).toBeGreaterThan(-1);
    // Same last-match-wins hazard as the stamp negations above: placed ABOVE
    // the include it would still be overridden.
    if (includeAt > -1) expect(gitAt).toBeGreaterThan(includeAt);

    // And it must NOT have been written as a negation-defeating blanket that
    // also swallows the build stamp — `build-meta` is re-included below it.
    expect(lines.some((l) => l === '!build-meta/**' || l.startsWith('!build-meta/'))).toBe(true);
  });

  it('preflight still guards the stamp — the ONLY check that catches a reused-checkout stale file', () => {
    // The gitignored commit.txt PERSISTS in a reused deploy tree, so skipping
    // the writer bakes the PREVIOUS deploy's SHA. `git status` cannot see it
    // (ignored files are not dirty) and the unit tests cannot (temp dir). Gate 4
    // of preflight-deploy.sh is the only thing standing there.
    //
    // LIMITATION, stated rather than implied: this asserts the gate EXISTS, not
    // that it behaves. Running it needs network (it curls /api/readiness), so it
    // is not CI-runnable. Behaviour was verified by hand across all three states
    // — absent → UNSTAMPED, stale → STALE, matching → OK.
    const preflight = read('scripts/preflight-deploy.sh');
    expect(preflight).toMatch(/build-meta\/commit\.txt/);
    // It must COMPARE against HEAD; merely checking the file exists would let a
    // stale stamp through, which is the entire defect.
    //
    // Asserting the comparison EXPRESSION, not the bare token `$HEAD_SHA` — that
    // token appears in gates 1 and 3 (lines 51-102) too, so matching it passed
    // even with Gate 4 deleted entirely. A second assertion of mine that was
    // green for the wrong reason.
    expect(preflight).toMatch(/\[\s*"\$stamp"\s*=\s*"\$HEAD_SHA"\s*\]/);
  });

  it('the writer targets exactly the path the Dockerfile and reader agree on', () => {
    // Three declarations, one path. Drift between any two is silent.
    const writer = read('scripts/write-build-commit.mjs');
    expect(writer).toMatch(/join\(ROOT, 'build-meta'\)/);
    expect(writer).toMatch(/join\(OUT_DIR, 'commit\.txt'\)/);
  });

  it('THE READER uses the same dir + sentinel — the resolver every other test bypasses', () => {
    // MEASURED GAP (2026-08-10): renaming the dir/sentinel in buildInfo.ts to
    // 'build-metaX'/'.gitkeepX' breaks production outright — locateRepoDir would
    // never find it, so every deploy reports `unknown` — and ALL 38 tests still
    // passed. The provenance tests set OPENWOP_BUILD_META_DIR, which BYPASSES
    // locateRepoDir, and the resolution test above hardcodes the same literals
    // instead of reading them from the source.
    //
    // So this asserts the SOURCE's literals. It is the only thing tying the
    // reader to the directory the Dockerfile actually ships.
    const reader = read('backend/typescript/src/host/buildInfo.ts');
    expect(reader).toMatch(/locateRepoDir\(\s*here,\s*'build-meta',\s*'\.gitkeep'\s*\)/);
    expect(reader).toMatch(/join\(dir, 'commit\.txt'\)/);
  });
});

describe('production path resolution (locateRepoDir), not the test override', () => {
  it('resolves build-meta from a simulated /app/lib runtime layout', () => {
    // Every provenance unit test uses OPENWOP_BUILD_META_DIR, which BYPASSES the
    // resolver the real image uses. This exercises the actual walk: in the image
    // the bundle is /app/lib/index.js and the payload is /app/build-meta/.
    const root = mkdtempSync(join(tmpdir(), 'owp-applayout-'));
    try {
      mkdirSync(join(root, 'lib'), { recursive: true });
      mkdirSync(join(root, 'build-meta'), { recursive: true });
      writeFileSync(join(root, 'build-meta', '.gitkeep'), '', 'utf8');
      writeFileSync(
        join(root, 'build-meta', 'commit.txt'),
        'e65ff6888e1eb6f72474f8606805873591f29091\n',
        'utf8',
      );

      const found = locateRepoDir(join(root, 'lib'), 'build-meta', '.gitkeep');
      expect(found).toBe(join(root, 'build-meta'));
      expect(readImageCommit(found)).toBe('e65ff6888e1eb6f72474f8606805873591f29091');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
