/**
 * ADR 0555 P2 — where the forked worker's entry FILE comes from.
 *
 * Two lanes, because the two runtimes disagree about what exists on disk:
 *
 *   1. BUILT (production). `scripts/build.mjs` emits `lib/packIsolationWorker.js`
 *      beside `lib/index.js`. In the bundle `import.meta.url` IS `lib/index.js`,
 *      so the sibling resolves directly. The runtime image ships `lib/` and
 *      `npm ci --omit=dev` deps, so this is the only lane available there — and
 *      it is the only lane that needs to be.
 *   2. BUNDLED ON DEMAND (dev, vitest). There is no `lib/`, the sources are
 *      TypeScript, and esbuild is present as a devDependency. The entry is
 *      bundled once per process into a temp dir using the SAME options object
 *      lane 1 uses (`scripts/lib/isolation-worker-build.mjs`), so the two lanes
 *      cannot drift into building different artifacts.
 *
 * Lane 2 is a convenience, not a fallback: it is unreachable in production
 * (esbuild is absent) and reaching for it there yields `unavailable`, which the
 * adapter turns into a REFUSED dispatch. Nothing downgrades.
 *
 * ── THE LATCH RULE ────────────────────────────────────────────────────────
 *
 * The memo is a module-scope promise, which `ARCHITECTURE.md`'s "work that
 * outlives the thing that started it" row makes a hazard: a promise that never
 * settles has not rejected either, so a stuck first attempt would wedge every
 * later dispatch. It is therefore cleared on REJECTION, so a transient failure
 * (a half-written temp dir, a racing `rm -rf`) is retried by the next dispatch
 * instead of being cached forever.
 */

import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Kept in sync with `scripts/lib/isolation-worker-build.mjs` by
 *  `pack-isolation-build-wiring.test.ts`, which reads both. */
const WORKER_BASENAME = 'packIsolationWorker.mjs';
const SHARED_BUILD_MODULE = 'scripts/lib/isolation-worker-build.mjs';

export type WorkerEntryResolution =
  | { readonly ok: true; readonly path: string; readonly lane: 'built' | 'bundled' }
  | { readonly ok: false; readonly reason: string };

let memo: Promise<WorkerEntryResolution> | null = null;

/**
 * `OPENWOP_PACK_ISOLATION_WORKER` — an explicit absolute path to the worker.
 *
 * For an operator whose image lays `lib/` out differently, and NOT memoized, so
 * it is also how the "the worker is missing ⇒ REFUSE" arm is exercised for real
 * rather than by mocking the resolver: point it at a file, delete the file,
 * dispatch again. An override that is set but absent is a hard `{ok:false}` —
 * it never silently falls through to a discovered worker, because an operator
 * who named a path meant that path.
 */
export function resolveWorkerEntry(env: NodeJS.ProcessEnv = process.env): Promise<WorkerEntryResolution> {
  const override = env.OPENWOP_PACK_ISOLATION_WORKER?.trim();
  if (override) {
    return Promise.resolve(
      existsSync(override)
        ? { ok: true, path: realpathSync(override), lane: 'built' }
        : { ok: false, reason: `OPENWOP_PACK_ISOLATION_WORKER points at ${override}, which does not exist` },
    );
  }
  memo ??= resolve().catch((err: unknown) => {
    memo = null; // never cache a failure — see the latch rule above
    return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
  });
  return memo;
}

/** Test seam — forget the memo so a suite can exercise both lanes. */
export function __resetWorkerEntryForTests(): void {
  memo = null;
}

async function resolve(): Promise<WorkerEntryResolution> {
  // ── lane 1: the built artifact ─────────────────────────────────────────
  const built = fileURLToPath(new URL(`./${WORKER_BASENAME}`, import.meta.url));
  if (existsSync(built)) return { ok: true, path: realpathSync(built), lane: 'built' };

  // ── lane 2: bundle on demand ───────────────────────────────────────────
  const pkgRoot = findPackageRoot();
  if (!pkgRoot) {
    return { ok: false, reason: `no built worker at ${built} and the package root could not be located` };
  }
  // Both specifiers are COMPUTED so esbuild cannot statically analyse them into
  // the production bundle: `scripts/` is not shipped in the runtime image, and
  // esbuild itself is a devDependency that must not become a runtime import.
  const optionsModule = pathToFileURL(join(pkgRoot, SHARED_BUILD_MODULE)).href;
  const { isolationWorkerBuildOptions } = (await import(/* @vite-ignore */ optionsModule)) as {
    isolationWorkerBuildOptions: (pkgRoot: string, outfile?: string) => Record<string, unknown>;
  };
  const esbuildSpecifier = ['es', 'build'].join('');
  const esbuild = (await import(/* @vite-ignore */ esbuildSpecifier)) as {
    build: (opts: Record<string, unknown>) => Promise<unknown>;
  };

  const outDir = mkdtempSync(join(realpathSync(tmpdir()), 'owp-pack-worker-'));
  const outfile = join(outDir, WORKER_BASENAME);
  await esbuild.build(isolationWorkerBuildOptions(pkgRoot, outfile));
  if (!existsSync(outfile)) {
    return { ok: false, reason: `on-demand worker bundle produced no file at ${outfile}` };
  }
  return { ok: true, path: outfile, lane: 'bundled' };
}

/** Walk up from this module until the directory holding the shared build
 *  options is found. Not `process.cwd()` — vitest's cwd is the package root
 *  today and would make this quietly cwd-dependent tomorrow. */
function findPackageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, SHARED_BUILD_MODULE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
