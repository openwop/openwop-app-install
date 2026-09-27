/**
 * ADR 0550 (H48) — `conformance-fixtures/` must stay at parity with the PINNED
 * `@openwop/openwop-conformance`, and the guard that says so must actually run.
 *
 * Two independent inputs feed one behaviour:
 *   - `src/host/index.ts` loads every top-level `*.json` under the VENDORED dir
 *     as a black-box workflow and advertises the ids via `capabilities.fixtures`.
 *   - the conformance SUITE reads only its own package copy under `node_modules`.
 * `scripts/sync-fixtures.sh` fills the vendored dir from the CORPUS, never from
 * `node_modules`, so the two can disagree while every version string reads the
 * same number. They had: at 1.136.0 the vendored tree was missing seven files.
 * H47 (#3315) found it only because it happened to hand-vendor two of them.
 *
 * This file asserts BOTH halves of the fix:
 *   1. the guard is WIRED into `scripts/ci.sh` (a check that exists but never
 *      runs is the class this repo keeps finding — `ci-gate-coverage.test.ts`);
 *   2. the guard can FAIL — each of the three violation shapes is executed
 *      against a throwaway copy of the tree, because a guard that has never
 *      gone red is indistinguishable from one whose assertion never ran.
 *
 * The failure cases run the real script against a COPY (`OPENWOP_APP_ROOT`-free:
 * the script derives its root from its own path, so the copy includes the script
 * and the fixture dir). Nothing here mutates the working tree.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const GUARD = join(ROOT, 'scripts', 'check-vendored-fixtures.mjs');

/**
 * Shell text with `#`-comment lines removed.
 *
 * Both these scripts carry long rationale headers that NAME the very strings
 * asserted below (`rm -rf "$VENDORED"`, `conformance-replay-effect`, `vitest`).
 * A first cut of this file matched those comments and produced three red
 * assertions against correct code — an ordering check "failed" because
 * `indexOf` found the prose mention of a step before the step itself. Asserting
 * on the executable body is the fix; it also means a future author can freely
 * document a hazard by name without breaking the gate that guards it.
 */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const CI_SH = code(readFileSync(join(ROOT, 'scripts', 'ci.sh'), 'utf8'));

/** The tag the throwaway corpora below carry. Any name works; the script reads refs/tags. */
const CORPUS_TEST_TAG = 'openwop-conformance/v0.0.0-test';

/**
 * A throwaway corpus: a real git repo whose `conformance/fixtures` is the pinned
 * package's tree, committed and tagged.
 *
 * It is a REPO, not a bare directory, because `sync-fixtures.sh` reads the
 * fixtures out of the tag (`git archive`) instead of out of the working tree —
 * the defect an adopter hit on 2026-09-23, when a clone one release ahead of the
 * pin made the guard's own remediation line vendor the wrong release.
 *
 * Returns the corpus root.
 */
function makeTagCorpus(root: string): string {
  const fixtures = join(root, 'conformance', 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  cpSync(join(ROOT, 'backend', 'typescript', 'node_modules', '@openwop', 'openwop-conformance', 'fixtures'), fixtures, {
    recursive: true,
  });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixtures');
  git('tag', CORPUS_TEST_TAG);
  return root;
}

/** Run `sync-fixtures.sh` from a scratch root. Returns exit code + combined output. */
function runSync(root: string, args: string[], corpusDir: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [join(root, 'scripts', 'sync-fixtures.sh'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENWOP_CORPUS_DIR: corpusDir, OPENWOP_CORPUS_TAG: '' },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Run the guard from a scratch root. Returns exit code + combined output. */
function runGuard(root: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'check-vendored-fixtures.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The corpus arm is a DIAGNOSIS input, not the assertion. Point it at a
      // path that does not exist so these cases exercise the primary
      // vendored-vs-pinned comparison deterministically, on any machine.
      env: { ...process.env, OPENWOP_CORPUS_DIR: join(root, '__no_corpus__') },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** A scratch repo root carrying the script, the fixture tree, and the pinned package. */
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'h48-fixture-parity-'));
  mkdirSync(join(scratch, 'scripts'), { recursive: true });
  cpSync(GUARD, join(scratch, 'scripts', 'check-vendored-fixtures.mjs'));
  cpSync(join(ROOT, 'conformance-fixtures'), join(scratch, 'conformance-fixtures'), { recursive: true });
  // The guard resolves the pinned package via createRequire on
  // backend/typescript/package.json, so the scratch root needs both.
  const pkgDir = join(scratch, 'backend', 'typescript', 'node_modules', '@openwop', 'openwop-conformance');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(scratch, 'backend', 'typescript', 'package.json'),
    JSON.stringify({ name: 'scratch', devDependencies: { '@openwop/openwop-conformance': '^1.136.0' } }),
  );
  const realPkg = join(ROOT, 'backend', 'typescript', 'node_modules', '@openwop', 'openwop-conformance');
  writeFileSync(join(pkgDir, 'package.json'), readFileSync(join(realPkg, 'package.json'), 'utf8'));
  cpSync(join(realPkg, 'fixtures'), join(pkgDir, 'fixtures'), { recursive: true });
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('ADR 0550 / H48 — the vendored-fixture parity guard is wired into the merge gate', () => {
  it('scripts/ci.sh invokes check-vendored-fixtures.mjs', () => {
    expect(CI_SH).toMatch(/node "\$ROOT\/scripts\/check-vendored-fixtures\.mjs"/);
  });

  it('it runs next to the vendored-SCHEMA guard, not in some later lane', () => {
    // Both answer "is a vendored copy of upstream still true?". Keeping them
    // adjacent is why the fixture gap was noticeable at all once looked for; a
    // guard buried after the 10-minute vitest lane gets skipped by everyone
    // debugging something else.
    const schemas = CI_SH.indexOf('check-vendored-schemas.mjs');
    const fixtures = CI_SH.indexOf('check-vendored-fixtures.mjs');
    expect(schemas).toBeGreaterThan(-1);
    expect(fixtures).toBeGreaterThan(schemas);
    expect(CI_SH.indexOf('vitest')).toBeGreaterThan(fixtures);
  });

  it('the guard is GREEN on the tree as committed — else every red below is ambiguous', () => {
    const { code, out } = runGuard(scratch);
    expect(out).toContain('check-vendored-fixtures: ok');
    expect(code).toBe(0);
  });
});

describe('ADR 0550 / H48 — the guard can FAIL (three violation shapes)', () => {
  /** Copy the scratch root, mutate it, run the guard. Isolated per case. */
  function withMutatedTree(mutate: (root: string) => void): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'h48-mutate-'));
    try {
      cpSync(scratch, dir, { recursive: true });
      mutate(dir);
      return runGuard(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('MISSING: a fixture present in the pin but deleted from the vendored tree', () => {
    const { code, out } = withMutatedTree((d) => {
      rmSync(join(d, 'conformance-fixtures', 'conformance-agent-memory-injection-budget.json'));
    });
    expect(code).toBe(1);
    expect(out).toContain('MISSING (in pin, not vendored): conformance-agent-memory-injection-budget.json');
    // The message must name WHICH SIDE is stale, not just report a delta.
    expect(out).toContain('cannot say which side is stale'); // no corpus in this run — stated, not guessed
  });

  it('MISSING also catches a whole SUBDIRECTORY nothing in-repo reads', () => {
    // `connection-packs/` and `trigger-events/` were missing precisely because
    // no in-repo reader named them. A guard scoped to "what something reads"
    // would have kept missing them, so the scope is the whole tree.
    const { code, out } = withMutatedTree((d) => {
      rmSync(join(d, 'conformance-fixtures', 'trigger-events'), { recursive: true });
    });
    expect(code).toBe(1);
    expect(out).toContain('MISSING (in pin, not vendored): trigger-events/trigger-event-change.json');
  });

  it('EXTRA: an un-allowlisted file in the vendored tree', () => {
    const { code, out } = withMutatedTree((d) => {
      writeFileSync(join(d, 'conformance-fixtures', 'conformance-invented.json'), '{"id":"conformance-invented"}\n');
    });
    expect(code).toBe(1);
    expect(out).toContain('EXTRA   (vendored, unaccounted): conformance-invented.json');
    expect(out).toContain('add it to HOST_AUTHORED');
  });

  it('DRIFT: same path, different bytes', () => {
    const { code, out } = withMutatedTree((d) => {
      const p = join(d, 'conformance-fixtures', 'conformance-mcp-tool-roundtrip.json');
      const doc = JSON.parse(readFileSync(p, 'utf8')) as { nodes?: { typeId?: string }[] };
      // The exact H47 regression: revert the node to its pre-rename spelling.
      if (doc.nodes?.[0]) doc.nodes[0].typeId = 'core.ai.callPrompt';
      writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
    });
    expect(code).toBe(1);
    expect(out).toContain('DRIFT   (bytes differ):          conformance-mcp-tool-roundtrip.json');
  });

  it('ALLOWLIST ROT: an entry naming a file that is not there', () => {
    // An allowlist is a claim about the tree. If the claim stops being true the
    // guard must say so, or the list silently accumulates permissions for files
    // nobody has.
    const { code, out } = withMutatedTree((d) => {
      rmSync(join(d, 'conformance-fixtures', 'conformance-replay-effect.json'));
    });
    expect(code).toBe(1);
    expect(out).toContain('ALLOWLIST: conformance-replay-effect.json');
    expect(out).toContain('delete the entry');
  });
});

describe('ADR 0550 / H48 — the allowlist has ONE source of truth', () => {
  it('--list-host-authored prints it, and sync-fixtures.sh consumes THAT', () => {
    const listed = execFileSync(process.execPath, [GUARD, '--list-host-authored'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(listed).toContain('form-content/');
    expect(listed).toContain('conformance-replay-effect.json');

    const sync = code(readFileSync(join(ROOT, 'scripts', 'sync-fixtures.sh'), 'utf8'));
    expect(sync).toContain('--list-host-authored');
    // The point of the single source: the sync script must NOT restate the
    // paths in its BODY. A second copy is what drifts, and here the drift is
    // destructive. (Naming them in a comment is fine — encouraged, even.)
    expect(sync).not.toContain('form-content');
    expect(sync).not.toContain('conformance-replay-effect');
  });

  it('an ABORT between the wipe and the restore still leaves the host-authored paths intact', () => {
    // The failure path is the one that matters, and a first cut of the script
    // got it wrong: the mirror assertion ran inline under `set -e`, so when it
    // failed the shell aborted before the restore and the EXIT trap deleted the
    // stash — reintroducing, on the failure path, the exact landmine this script
    // exists to remove. Measured: replay-effect 2 -> 0, form-content gone.
    //
    // Driven by STUBBING the assertion to `false` in a throwaway copy, which is
    // the only way to reach that branch deterministically. The stub is asserted
    // present before the script runs, so a sed that silently failed to apply
    // cannot make this test pass for the wrong reason.
    const dir = mkdtempSync(join(tmpdir(), 'h48-abort-'));
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      cpSync(join(ROOT, 'conformance-fixtures'), join(dir, 'conformance-fixtures'), { recursive: true });
      cpSync(GUARD, join(dir, 'scripts', 'check-vendored-fixtures.mjs'));

      const original = readFileSync(join(ROOT, 'scripts', 'sync-fixtures.sh'), 'utf8');
      // Match the assertion line whatever trails it (`|| mirror_status=$?` today,
      // bare `>/dev/null` in the pre-fix spelling). A first cut pinned the exact
      // current text and, when the fix was reverted to prove this test works, the
      // stub silently failed to apply — so the test went red on its own
      // non-vacuity guard instead of on the defect. Right outcome, wrong
      // assertion, and it would have been the WRONG outcome had that guard been
      // absent.
      const stubbed = original.replace(/^diff -rq "\$CANONICAL" "\$VENDORED" >\/dev\/null.*$/m, 'false');
      expect(stubbed, 'the mirror assertion was not stubbed — this test would prove nothing').not.toBe(original);
      writeFileSync(join(dir, 'scripts', 'sync-fixtures.sh'), stubbed);

      // A corpus to sync FROM: the pinned package's fixtures are byte-identical
      // to the corpus at this version, so they stand in exactly. It is a real
      // git repo with a real tag, because the script reads the fixtures out of
      // the TAG (`git archive`) rather than out of the working tree.
      const corpusRoot = makeTagCorpus(join(dir, 'corpus'));

      let code = 0;
      try {
        execFileSync('bash', [join(dir, 'scripts', 'sync-fixtures.sh'), '--tag', CORPUS_TEST_TAG], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, OPENWOP_CORPUS_DIR: corpusRoot },
        });
      } catch (err) {
        code = (err as { status?: number }).status ?? 1;
      }

      expect(code, 'a failed mirror assertion MUST still be a failure').toBe(1);
      // ...and the host-authored paths MUST have survived it.
      const vend = join(dir, 'conformance-fixtures');
      expect(existsSync(join(vend, 'conformance-replay-effect.json'))).toBe(true);
      expect(existsSync(join(vend, 'conformance-replay-effect-unreached.json'))).toBe(true);
      expect(existsSync(join(vend, 'form-content'))).toBe(true);
      // The restore must not have nested the dir inside itself (`cp -R` into an
      // existing directory), which is why the function rm -rf's its target.
      expect(existsSync(join(vend, 'form-content', 'form-content'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sync-fixtures.sh no longer opens with an unconditional rm -rf of the vendored dir', () => {
    // The live landmine H48 found: the documented DEPLOY.md refresh deleted
    // form-content/ and both replay-effect fixtures, reddening
    // form-content-seam.test.ts and both RFC 0137 instantiation legs.
    const sync = code(readFileSync(join(ROOT, 'scripts', 'sync-fixtures.sh'), 'utf8'));
    const wipeAt = sync.indexOf('rm -rf "$VENDORED"');
    const preserveAt = sync.indexOf('--list-host-authored');
    expect(wipeAt).toBeGreaterThan(-1); // the canonical half IS still mirrored
    expect(preserveAt).toBeGreaterThan(-1);
    expect(preserveAt, 'the host-authored paths must be stashed BEFORE the wipe').toBeLessThan(wipeAt);
  });

  it('every host-authored path really is absent from the pinned package', () => {
    // Non-vacuity for the allowlist itself: if one of these were shipped by the
    // suite, allowlisting it would be masking a real drift rather than
    // recording repo ownership.
    const pinned = join(ROOT, 'backend', 'typescript', 'node_modules', '@openwop', 'openwop-conformance', 'fixtures');
    const top = new Set(readdirSync(pinned));
    expect(top.has('conformance-replay-effect.json')).toBe(false);
    expect(top.has('conformance-replay-effect-unreached.json')).toBe(false);
    expect(top.has('form-content')).toBe(false);
    // ...and the corpus's OWN RFC 0140 fixture, which is canonical, IS there —
    // so the check above is not passing because the directory read failed.
    expect(top.has('conformance-replay-side-effect.json')).toBe(true);
  });
});

describe('sync-fixtures.sh vendors A NAMED TAG, never the corpus working tree', () => {
  // The defect an adopter hit on 2026-09-23 while vendoring: `sync-schemas.sh`
  // required `--tag` and refused without it, `sync-fixtures.sh` took no tag at
  // all and copied the sibling clone's WORKING TREE. With the clone ahead of the
  // pin (clone 2.36.1, pin 2.36.0), a failing `check-vendored-fixtures` printed
  // "run sync-fixtures.sh", and that run vendored the WRONG release — failing the
  // same guard for the opposite reason. The workaround was a throwaway detached
  // worktree at the tag plus OPENWOP_CORPUS_DIR.
  //
  // Each case runs the REAL script against a throwaway repo root, so a revert of
  // the fix turns them red rather than merely un-asserted.
  function scratchRoot(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'scripts', 'sync-fixtures.sh'), join(dir, 'scripts', 'sync-fixtures.sh'));
    cpSync(GUARD, join(dir, 'scripts', 'check-vendored-fixtures.mjs'));
    cpSync(join(ROOT, 'conformance-fixtures'), join(dir, 'conformance-fixtures'), { recursive: true });
    return dir;
  }

  it('refuses with no --tag, and names the flag', () => {
    const dir = scratchRoot('h48-notag-');
    try {
      const corpus = makeTagCorpus(join(dir, 'corpus'));
      const { code: status, out } = runSync(dir, [], corpus);
      expect(status, 'an untagged sync MUST refuse').toBe(1);
      expect(out).toContain('--tag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a tag the corpus does not carry', () => {
    const dir = scratchRoot('h48-badtag-');
    try {
      const corpus = makeTagCorpus(join(dir, 'corpus'));
      const { code: status, out } = runSync(dir, ['--tag', 'openwop-conformance/v0.0.0-absent'], corpus);
      expect(status).toBe(1);
      expect(out).toContain('does not exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies the TAG even when the working tree has moved on, and leaves the clone untouched', () => {
    const dir = scratchRoot('h48-tagread-');
    try {
      const corpus = makeTagCorpus(join(dir, 'corpus'));
      // The clone moves ahead of the tag — exactly the adopter's situation.
      const sentinel = join(corpus, 'conformance', 'fixtures', 'from-a-later-release.json');
      writeFileSync(sentinel, '{"id":"from-a-later-release"}\n');
      const headBefore = execFileSync('git', ['-C', corpus, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

      const { code: status } = runSync(dir, ['--tag', CORPUS_TEST_TAG], corpus);
      expect(status, 'a tagged sync against a moved-on clone MUST succeed').toBe(0);

      // The load-bearing assertion: the post-tag file is NOT in the vendored tree.
      expect(
        existsSync(join(dir, 'conformance-fixtures', 'from-a-later-release.json')),
        'the working tree was copied instead of the tag',
      ).toBe(false);
      // ...and the file really was reachable from the working tree, so the
      // assertion above cannot pass because the write silently failed.
      expect(existsSync(sentinel)).toBe(true);
      // The canonical half still arrived (this is a sync, not a no-op).
      expect(existsSync(join(dir, 'conformance-fixtures', 'conformance-replay-side-effect.json'))).toBe(true);

      // No side effect on the clone: HEAD unmoved, and the only dirt is the
      // sentinel this test wrote. Other sessions work in that checkout.
      expect(execFileSync('git', ['-C', corpus, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(headBefore);
      const dirty = execFileSync('git', ['-C', corpus, 'status', '--porcelain'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      expect(dirty).toEqual(['?? conformance/fixtures/from-a-later-release.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the guard prints a remediation that names the tag matching the installed pin', () => {
    // A remediation line the reader can paste. It used to say a bare
    // `bash scripts/sync-fixtures.sh`, which under the tag contract is now a
    // command that refuses — and before it, one that vendored the wrong release.
    const pinned = JSON.parse(
      readFileSync(
        join(ROOT, 'backend', 'typescript', 'node_modules', '@openwop', 'openwop-conformance', 'package.json'),
        'utf8',
      ),
    ).version as string;
    // The scratch root (not scratchRoot()) — the guard resolves the pinned
    // package through backend/typescript, which only that root carries.
    const dir = mkdtempSync(join(tmpdir(), 'h48-remediation-'));
    try {
      cpSync(scratch, dir, { recursive: true });
      rmSync(join(dir, 'conformance-fixtures', 'conformance-replay-side-effect.json'));
      const { code: status, out } = runGuard(dir);
      expect(status).toBe(1);
      expect(out).toContain(`bash scripts/sync-fixtures.sh --tag openwop-conformance/v${pinned}`);
      expect(out, 'a bare sync-fixtures.sh now refuses — the line must carry a tag').not.toMatch(
        /`bash scripts\/sync-fixtures\.sh`/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
