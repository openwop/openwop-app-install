/**
 * ADR 0555 P2 — the ONE definition of how the pack-isolation worker entry is
 * bundled. Imported by `scripts/build.mjs` (the production artifact) and by
 * `src/host/isolation/workerEntry.ts` (the dev/test lane).
 *
 * ── WHY THIS IS A SHARED MODULE AND NOT TWO CALLS ─────────────────────────
 *
 * The worker has to exist as a runnable JS FILE at spawn time, and the two
 * runtimes that need it disagree about what exists:
 *
 *   production   the image ships only `lib/` and `npm ci --omit=dev` deps, so
 *                esbuild is NOT installed and the file must be a build output
 *   dev / vitest there is no `lib/`, the sources are TypeScript, and esbuild IS
 *                installed as a devDependency
 *
 * The obvious shape — "build.mjs emits it for prod, the adapter bundles it
 * lazily for tests" — is two configurations for one artifact, and the test lane
 * would then be the only one ever exercised. That is a gate that cannot fail:
 * a divergence in the production options ships green. Both lanes therefore call
 * THIS function, so there is no second configuration to drift, and the only
 * remaining delta — whether `build.mjs` actually calls it — is pinned by
 * `pack-isolation-build-wiring.test.ts` reading `build.mjs`.
 *
 * (Same discipline as this ADR's P0 content digest, which is one algorithm with
 * two implementations held together by a parity test. Here it is one
 * configuration with two callers, which is strictly the easier version.)
 */

import { join } from 'node:path';

/**
 * Basename of the built worker, in `lib/`. Kept here so both lanes agree.
 *
 * `.mjs`, NOT `.js`, and that is load-bearing rather than stylistic. Node decides
 * a `.js` file's module system from the NEAREST `package.json`, so an ESM bundle
 * named `.js` loads fine beside `lib/index.js` (where `/app/package.json` says
 * `"type": "module"`) and fails as CJS the moment it is written anywhere else —
 * which is exactly what the dev/test lane does, into a temp directory with no
 * package.json above it. `.mjs` is unambiguous everywhere and removes the need
 * to widen the isolate's read allowlist to a whole directory just so Node can
 * find a manifest.
 */
export const ISOLATION_WORKER_BASENAME = 'packIsolationWorker.mjs';

/** Source of truth for the worker's entry module, relative to the package root. */
export const ISOLATION_WORKER_ENTRY = 'src/host/isolation/packIsolationWorkerEntry.ts';

/**
 * esbuild options for the worker bundle.
 *
 * `bundle: true` with `packages: 'external'` matches the main build: the worker
 * pulls in `packWorkerRunner.ts` + `packWorkerContract.ts` (its only imports,
 * both dependency-free) and nothing from npm — so the artifact is self-contained
 * and can run in a process whose filesystem allowlist names only itself and one
 * pack directory. If this ever starts pulling host modules in, the boundary
 * `packWorkerRunner.ts`'s header describes has been broken.
 *
 * @param pkgRoot absolute path to `backend/typescript`
 * @param outfile absolute path to write; defaults to `<pkgRoot>/lib/<basename>`
 */
export function isolationWorkerBuildOptions(pkgRoot, outfile = join(pkgRoot, 'lib', ISOLATION_WORKER_BASENAME)) {
  return {
    entryPoints: [join(pkgRoot, ISOLATION_WORKER_ENTRY)],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile,
    packages: 'external',
    sourcemap: true,
  };
}
