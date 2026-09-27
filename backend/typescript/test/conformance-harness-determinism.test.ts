/**
 * The conformance harness must depend on the COMMIT, not the machine.
 *
 * WHY THIS EXISTS. `conformance/run.ts` boots via `createApp`, so `index.ts
 * main()` never runs and `ensureLocalPacksMounted()` never fires. Before
 * 2026-08-13 the suite therefore read whatever the shared `~/.openwop-packs`
 * happened to hold. On the measuring machine `core.openwop.ai` was a directory
 * containing only `.openwop-installed.json`, so `core.ai.structuredOutput` —
 * the single node in every `conformance-envelope-*` fixture — never resolved.
 * Ten scenarios were quarantined as "pre-existing failure on main, not
 * diagnosed", which reads as host non-conformance. MEASURED: ambient dir 8
 * files / 26 tests failing; vendored packs mounted 403 files / 2565 passing.
 * Same commit.
 *
 * WHAT THIS CAN AND CANNOT CHECK. It is a SOURCE SCAN of `run.ts`, not an
 * execution of it — booting the whole conformance harness inside a unit test
 * would cost minutes and duplicate the gate. So it pins the two structural
 * properties whose loss reintroduces the bug, and it cannot prove the harness
 * is deterministic in general. Said plainly so nobody reads a green here as
 * that stronger claim.
 *
 * The two properties, and why each is load-bearing:
 *
 *   1. `run.ts` sets `OPENWOP_PACK_DIR` itself. Without it the suite inherits
 *      ambient state and its result stops being about the commit.
 *
 *   2. `../src/index.js` is imported DYNAMICALLY, not statically. This is the
 *      subtle one and it already bit once: `bootstrap/nodePackResolver.ts` and
 *      `bootstrap/agentPackResolver.ts` both do
 *      `const PACK_DIR = resolveDefaultPackDir()` at MODULE SCOPE, so a static
 *      import freezes the pack dir before `main()` can set it. The first fix
 *      had property 1 and not property 2: the log said "mounted 208 vendored
 *      pack(s)" and ten files stayed red, because the mount was real and the
 *      resolver ignored it. A reviewer reordering imports for tidiness would
 *      silently undo this.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN_TS = readFileSync(join(__dirname, '..', 'conformance', 'run.ts'), 'utf8');

describe('conformance harness determinism', () => {
  it('run.ts chooses its own OPENWOP_PACK_DIR', () => {
    expect(
      /process\.env\.OPENWOP_PACK_DIR\s*=/.test(RUN_TS),
      'conformance/run.ts must set OPENWOP_PACK_DIR itself; otherwise the suite '
        + 'inherits the shared ~/.openwop-packs and measures the machine, not the commit',
    ).toBe(true);
  });

  it('run.ts does NOT statically import the app', () => {
    // A static `import ... from '../src/index.js'` executes before main(), and
    // the pack resolvers capture the pack dir at module scope — so the env
    // assignment above would be a no-op. Type-only imports are erased and are
    // therefore fine; match the runtime form specifically.
    const staticAppImport = /^import\s+(?!type\s)[^;]*from\s+['"]\.\.\/src\/index\.js['"]/m;
    expect(
      staticAppImport.test(RUN_TS),
      'conformance/run.ts must import ../src/index.js DYNAMICALLY (inside main, after '
        + 'OPENWOP_PACK_DIR is set). A static import freezes PACK_DIR in '
        + 'bootstrap/nodePackResolver.ts:24 and bootstrap/agentPackResolver.ts:24 before '
        + 'the assignment runs — the mount then succeeds while the resolver ignores it.',
    ).toBe(false);
  });

  it('run.ts imports the app dynamically somewhere', () => {
    // The mirror of the assertion above: proving the static form is absent is
    // not the same as proving the dynamic form is present. Without this,
    // deleting the import entirely would pass the previous test.
    expect(
      /await import\(\s*['"]\.\.\/src\/index\.js['"]\s*\)/.test(RUN_TS),
      'conformance/run.ts must still import the app — dynamically, inside main()',
    ).toBe(true);
  });

  it('the pack dir it chooses is NOT the shared ~/.openwop-packs', () => {
    // Writing to the shared dir is what created the hazard, and it races the
    // parallel-worktree sessions CLAUDE.md warns about.
    const assignment = RUN_TS.match(/process\.env\.OPENWOP_PACK_DIR\s*=\s*([^;]+);/);
    expect(assignment, 'expected an OPENWOP_PACK_DIR assignment to inspect').not.toBeNull();
    expect(
      /openwop-packs|homedir\(\)/.test(assignment![1]),
      'the harness must not point OPENWOP_PACK_DIR at the shared ~/.openwop-packs',
    ).toBe(false);
  });
});
