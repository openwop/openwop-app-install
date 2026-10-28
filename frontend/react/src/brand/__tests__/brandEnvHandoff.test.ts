// @vitest-environment node
/**
 * BRAND-01 — the brand build variables are one checked set (gap-closure plan
 * S01-R3, witness S01-T3 config half; audit BRAND-01).
 *
 * The defect: the compose pack forwarded ONE of the app's brand build variables
 * (`VITE_BRAND_PRODUCT_NAME`) into the frontend image, and nothing refused an
 * unknown one. An operator who set `VITE_BRAND_FAVICON_SRC` (or misspelled
 * `VITE_BRAND_PRODUCT_NAM`) got a clean build that silently shipped the default
 * identity in that slot. `VITE_BRAND_PRIVACY_URL` was also missing from the one
 * list the build had (`BRAND_ENV_KEYS`), because it is read in another file.
 *
 * Proven here:
 *   1. `KNOWN_BRAND_ENV_VARS` is exactly the set of `VITE_BRAND_*` names the
 *      app's source reads, so the list cannot drift from the code;
 *   2. the compose file and its Dockerfile forward exactly that set (build arg,
 *      `ARG`, and the line written into `.env.production`);
 *   3. the typo detector names an unknown variable and the likely intended one;
 *   4. the REAL Vite config refuses a misspelled brand variable: `vite build`
 *      exits non-zero naming it, before any bundling.
 *
 * Sabotage: deleting the `unknownBrandEnvVars` call in vite.config.ts reds case 4
 * (the build proceeds and the 60 s cap kills it). Dropping a variable from the
 * compose args reds case 2. Reading a new `VITE_BRAND_*` in src without adding it
 * to `BRAND_ENV_KEYS` reds case 1.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_BRAND_ENV_VARS, unknownBrandEnvVars } from '../defaults.js';

const FE = process.cwd();
const REPO = join(FE, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') walk(p, out);
    } else if (/\.(tsx?|html)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const names = (text: string): string[] => [...new Set([...text.matchAll(/VITE_BRAND_[A-Z0-9_]+/g)].map((m) => m[0]))].sort();

describe('BRAND-01 — one checked set of brand build variables', () => {
  it('1. the known set is exactly what the app source reads', () => {
    const read = names([...walk(join(FE, 'src')), join(FE, 'index.html')].map((p) => readFileSync(p, 'utf8')).join('\n'));
    expect([...KNOWN_BRAND_ENV_VARS].sort()).toEqual(read);
    expect(KNOWN_BRAND_ENV_VARS).toContain('VITE_BRAND_PRIVACY_URL');
  });

  it('2. the compose pack forwards exactly that set into the image', () => {
    const known = [...KNOWN_BRAND_ENV_VARS].sort();
    const compose = readFileSync(join(REPO, 'deploy/compose/docker-compose.yml'), 'utf8');
    const args = [...compose.matchAll(/^\s+(VITE_BRAND_[A-Z0-9_]+): \$\{\1:-\}$/gm)].map((m) => m[1]!).sort();
    expect(args).toEqual(known);
    const dockerfile = readFileSync(join(REPO, 'deploy/compose/frontend.Dockerfile'), 'utf8');
    expect([...dockerfile.matchAll(/^ARG (VITE_BRAND_[A-Z0-9_]+)=$/gm)].map((m) => m[1]!).sort()).toEqual(known);
    expect([...dockerfile.matchAll(/^\s+"(VITE_BRAND_[A-Z0-9_]+)=\$\{\1\}" \\$/gm)].map((m) => m[1]!).sort()).toEqual(known);
  });

  it('3. an unknown brand variable is named, with the likely intended one', () => {
    expect(unknownBrandEnvVars({
      VITE_BRAND_PRODUCT_NAM: 'Acme',
      VITE_BRAND_SOMETHING_ELSE_ENTIRELY: 'x',
      VITE_BRAND_FAVICON_SRC: '/f.svg',
      VITE_OPENWOP_BASE_URL: '/api',
    })).toEqual([
      { name: 'VITE_BRAND_PRODUCT_NAM', didYouMean: 'VITE_BRAND_PRODUCT_NAME' },
      { name: 'VITE_BRAND_SOMETHING_ELSE_ENTIRELY' },
    ]);
    expect(unknownBrandEnvVars(Object.fromEntries(KNOWN_BRAND_ENV_VARS.map((k) => [k, 'x'])))).toEqual([]);
  });

  it('4. the real Vite config refuses a misspelled brand variable before bundling', () => {
    const envDir = mkdtempSync(join(tmpdir(), 'brand-env-'));
    try {
      writeFileSync(join(envDir, '.env.production'), 'VITE_OPENWOP_BASE_URL=https://api.example.test\nVITE_BRAND_PRODUCT_NAM=Acme\n');
      const run = spawnSync(process.execPath, [join(FE, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'production', '--outDir', join(envDir, 'dist')], {
        cwd: FE,
        env: { ...process.env, OPENWOP_VITE_ENV_DIR: envDir },
        encoding: 'utf8',
        timeout: 60_000,
      });
      const out = `${run.stdout}\n${run.stderr}`;
      expect(run.status, out.slice(-2000)).not.toBe(0);
      expect(out).toContain('unknown brand variable(s): VITE_BRAND_PRODUCT_NAM (did you mean VITE_BRAND_PRODUCT_NAME?)');
    } finally {
      rmSync(envDir, { recursive: true, force: true });
    }
  }, 90_000);
});
