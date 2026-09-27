/**
 * ADR 0555 P2 — the gate that stops the two worker-entry lanes from drifting.
 *
 * The isolation worker must exist as a runnable file at spawn time, and the two
 * runtimes disagree about what exists: production ships only `lib/` and
 * production deps (no esbuild), while vitest has TypeScript sources and esbuild
 * as a devDependency. So `scripts/build.mjs` emits the artifact for production
 * and `workerEntry.ts` bundles it on demand for dev/test.
 *
 * That is a gate that cannot fail unless something pins it. **Only the dev lane
 * is ever exercised by the suite** — every test in this repo bundles on demand,
 * because `lib/` is not built during `vitest`. If `build.mjs` stopped emitting
 * the worker, or emitted it under a different name, or configured it
 * differently, the whole suite would stay green and untrusted packs would be
 * undispatchable in production only. Being refused rather than mis-executed is
 * the right failure, but discovering it in production is not.
 *
 * Two things are therefore asserted from the SOURCE:
 *
 *   1. both lanes call the SAME options function — so there is no second
 *      configuration that can drift (this is the structural half, and it is the
 *      reason the pin below can be as thin as it is);
 *   2. `build.mjs` actually calls it — the one fact the shared module cannot
 *      guarantee about itself.
 *
 * The `pack-trust-config.test.ts` Dockerfile pin is the precedent: read the
 * build input as text and assert the claim, because the artifact it produces is
 * not built here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Loaded dynamically because `scripts/` is plain `.mjs` outside `tsconfig`'s
 *  program — the same reason `workerEntry.ts` imports it by computed URL. The
 *  shape is asserted here so a rename in the shared module is a compile error
 *  in this pin rather than a silently-skipped assertion. */
const shared = (await import(
  new URL('../scripts/lib/isolation-worker-build.mjs', import.meta.url).href
)) as {
  ISOLATION_WORKER_BASENAME: string;
  ISOLATION_WORKER_ENTRY: string;
  isolationWorkerBuildOptions: (pkgRoot: string, outfile?: string) => { outfile: string };
};
const { ISOLATION_WORKER_BASENAME, ISOLATION_WORKER_ENTRY, isolationWorkerBuildOptions } = shared;

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(pkgRoot, rel), 'utf-8');

describe('the production worker artifact is actually built', () => {
  it('`scripts/build.mjs` imports the shared options and calls it', () => {
    const build = read('scripts/build.mjs');
    expect(build).toContain("from './lib/isolation-worker-build.mjs'");
    expect(build).toMatch(/await build\(isolationWorkerBuildOptions\(pkgRoot\)\)/);
  });

  it('the dev/test lane resolves the SAME basename the build emits', () => {
    // Two constants, one value. A rename on either side without the other means
    // production builds `a` and dev looks for `b`, and only production breaks.
    expect(read('src/host/isolation/workerEntry.ts')).toContain(`'${ISOLATION_WORKER_BASENAME}'`);
    expect(isolationWorkerBuildOptions('/pkg').outfile).toBe(`/pkg/lib/${ISOLATION_WORKER_BASENAME}`);
  });

  it('the dev/test lane imports the shared options module rather than configuring its own build', () => {
    // The structural guarantee. If this ever becomes a literal esbuild options
    // object in `workerEntry.ts`, the two lanes can differ and the pin above
    // stops being sufficient.
    const entry = read('src/host/isolation/workerEntry.ts');
    expect(entry).toContain('scripts/lib/isolation-worker-build.mjs');
    expect(entry).toContain('isolationWorkerBuildOptions');
    expect(entry, 'the dev lane must not carry its own esbuild configuration').not.toContain('entryPoints');
  });

  it('the worker is `.mjs`, so Node does not need a package.json to know it is ESM', () => {
    // A `.js` ESM bundle loads only where the nearest package.json says
    // `"type":"module"`. That holds beside `lib/index.js` and NOT in the temp
    // directory the dev lane writes to, so the extension is what makes one
    // artifact work in both places.
    expect(ISOLATION_WORKER_BASENAME.endsWith('.mjs')).toBe(true);
  });

  it('the bundled entry is the worker module, and it stays free of host imports', () => {
    expect(ISOLATION_WORKER_ENTRY).toBe('src/host/isolation/packIsolationWorkerEntry.ts');
    // The worker must reach the host ONLY through the `hostCall` function it is
    // handed (`packWorkerRunner.ts`'s header states this as the boundary test).
    // A host import here would drag the executor, the registries and the DB into
    // a process whose filesystem allowlist names two paths — it would not merely
    // be bloat, it would not boot.
    const source = read(ISOLATION_WORKER_ENTRY);
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../packWorkerContract.js', '../packWorkerRunner.js', './workerChannel.js']);
  });
});
