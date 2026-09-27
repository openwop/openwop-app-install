/**
 * Per-worker isolated pack dir for the test suite.
 *
 * The intermittent full-suite setup-timeout flake (a different integration
 * file each run, each passing in isolation) was contention on the SHARED
 * `~/.openwop-packs` dir: every per-file app boot calls
 * `ensureLocalPacksMounted()`, which creates/re-points/shadows symlinks in that
 * one dir, and parallel vitest workers racing those `symlinkSync`/`renameSync`/
 * `rmSync` operations on the same paths could stall a borderline `beforeAll`
 * past the hook timeout.
 *
 * `resolveDefaultPackDir()` (and the artifact-type loader) read
 * `OPENWOP_PACK_DIR` at call time, so pointing it at a per-WORKER temp dir here
 * — before any test imports the bootstrap — gives each worker its own pack tree
 * and removes the cross-worker contention entirely. The guard makes it
 * once-per-worker (env persists across files in a worker; `process.pid` is
 * stable within one). An explicit OPENWOP_PACK_DIR (CI/dev) is respected.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { afterAll } from 'vitest';

if (!process.env.OPENWOP_PACK_DIR) {
  const dir = join(tmpdir(), 'owp-test-packs', `w${process.pid}`);
  mkdirSync(dir, { recursive: true });
  process.env.OPENWOP_PACK_DIR = dir;
}

// ── Tripwire: a test file must not leak OPENWOP_PACK_DIR to its worker ────────
// `process.env` outlives a FILE inside a vitest worker, and `resolveDefaultPackDir()`
// reads this variable at CALL time — so a file that changes it and does not put it
// back silently re-points every LATER file in that worker at the wrong pack tree.
// Deleting it is the worse variant: the guard above only assigns when UNSET and runs
// once per worker, so a deletion drops the rest of the worker to the shared
// `~/.openwop-packs`, the cross-session contended dir.
//
// Three files were doing exactly this (`chainpack-signature` deleted it;
// `pack-uninstall` and `canvas-pack-editor` left it set). That is the general shape
// of an order-dependent, same-worker, intermittent failure in an UNRELATED file —
// the class a peer hit and could not localise. This makes the leak fail the file
// that CAUSES it instead of a downstream victim.
//
// `feature-toggle-dependencies.test.ts` is the reference pattern: capture, then
// restore-or-delete in an after-hook.
const EXPECTED_PACK_DIR = process.env.OPENWOP_PACK_DIR;
afterAll(() => {
  const actual = process.env.OPENWOP_PACK_DIR;
  if (actual !== EXPECTED_PACK_DIR) {
    throw new Error(
      `This test file leaked OPENWOP_PACK_DIR to its vitest worker: expected ${EXPECTED_PACK_DIR ?? '(unset)'}, `
      + `found ${actual ?? '(unset)'}. env outlives a file inside a worker, so every LATER file here would read the `
      + `wrong pack tree. Capture the previous value and restore-or-delete it in an after-hook `
      + `(see test/setup/isolatePackDir.ts and feature-toggle-dependencies.test.ts).`,
    );
  }
});
