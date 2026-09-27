#!/usr/bin/env node
/**
 * Backend build wrapper (ADR 0366 P1b) — replicates the former package.json
 * esbuild one-liner exactly, plus the distribution alias: when
 * OPENWOP_DISTRIBUTION names a non-default manifest, the feature registry
 * resolves to the GENERATED `index.distribution.ts` (produced by
 * scripts/gen-distribution.mjs, which this wrapper runs first) so excluded
 * features tree-shake out of the bundle. Default: generator no-ops and the
 * plugin never engages — byte-identical to the previous build.
 */
import { build } from 'esbuild';
import { isolationWorkerBuildOptions } from './lib/isolation-worker-build.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const distribution = process.env.OPENWOP_DISTRIBUTION ?? 'default';

// The generator lives at the REPO root. The Docker builder copies only the
// backend subtree, so for the default distribution its absence is expected
// (default generates nothing anyway); a NAMED distribution without it must
// fail loud — never silently build the full registry.
const genScript = join(repoRoot, 'scripts/gen-distribution.mjs');
if (existsSync(genScript)) {
  execFileSync('node', [genScript], { stdio: 'inherit', env: process.env });
} else if (distribution !== 'default') {
  console.error(`OPENWOP_DISTRIBUTION=${distribution} but ${genScript} is missing (build context without the repo root) — refusing to build the full registry silently.`);
  process.exit(1);
}

const REGISTRY = resolve(pkgRoot, 'src/features/index.ts');
const GENERATED = resolve(pkgRoot, 'src/features/index.distribution.ts');
const useDistribution = distribution !== 'default';
if (useDistribution && !existsSync(GENERATED)) {
  console.error(`OPENWOP_DISTRIBUTION=${distribution} but ${GENERATED} was not generated — refusing to build the full registry silently.`);
  process.exit(1);
}

rmSync(join(pkgRoot, 'lib'), { recursive: true, force: true });
await build({
  entryPoints: [join(pkgRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(pkgRoot, 'lib/index.js'),
  packages: 'external',
  sourcemap: true,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  plugins: useDistribution ? [{
    // Substitute at LOAD time, keyed on the RESOLVED absolute path — immune
    // to import-specifier variance ('./features/index.js', '../features/…'),
    // which an onResolve filter is not (two of five importers aliased, the
    // rest resolved canonically and BOTH registries landed in the bundle).
    name: 'distribution-registry-substitute',
    setup(b) {
      b.onLoad({ filter: /src[\\/]features[\\/]index\.ts$/ }, (args) => {
        if (resolve(args.path) !== REGISTRY) return undefined;
        return { contents: readFileSync(GENERATED, 'utf8'), loader: 'ts', resolveDir: dirname(REGISTRY) };
      });
    },
  }] : [],
});

// ADR 0555 P2 — a SECOND artifact: the pack-isolation worker entry.
//
// It cannot be part of the main bundle. The worker is `fork`ed as its own
// process with a filesystem allowlist that names only itself and one pack
// directory, so it has to be a standalone file — and it must never drag the
// host in behind it (see `scripts/lib/isolation-worker-build.mjs`). Emitted
// unconditionally: the child adapter refuses a dispatch it cannot spawn rather
// than downgrading, so a missing artifact is a production outage for untrusted
// packs, not a soft degradation.
await build(isolationWorkerBuildOptions(pkgRoot));

console.log(`backend built (distribution: ${distribution})`);
