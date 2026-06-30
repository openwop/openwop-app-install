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

if (!process.env.OPENWOP_PACK_DIR) {
  const dir = join(tmpdir(), 'owp-test-packs', `w${process.pid}`);
  mkdirSync(dir, { recursive: true });
  process.env.OPENWOP_PACK_DIR = dir;
}
