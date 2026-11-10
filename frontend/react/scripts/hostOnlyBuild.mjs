/**
 * ADR 1031 × ADR 0874 D4 — the HOST-ONLY build that `check-bundle-budget` measures
 * in an ADOPTER tree.
 *
 * The 129 kB entry ceiling is the HOST's number. #5006 already made the budgeted
 * build of an adopter bundle read host-only env (`OPENWOP_VITE_ENV_DIR`), so "the
 * adopter's own brand strings cannot red the host ceiling". ADR 1031 P3 re-opened
 * the same hole from the other side: adopter feature packages
 * (`src/adopter/features/<id>/`) ship in EVERY build of the adopter's repo,
 * the default distribution included, and their route metadata is eager by design
 * (`src/features/adopterFeatures.ts`). MEASURED on KickTodo at openwop-app
 * 48d891616 (2026-11-09): host code 127.9 kB, 1126 B under; KickTodo's adopted
 * features +2363 B; total 130.2 kB. The host grew into the headroom the KickTodo
 * packages left when #5512 deleted them, and the gate went red with no host
 * regression and no adopter change.
 *
 * With `OPENWOP_BUDGET_HOST_ONLY=1` (set ONLY by `scripts/ci.sh` on the adopter
 * bundle's budgeted build) every host-side `import.meta.glob` literal that names
 * `/src/adopter/features/` is pointed at a directory that cannot exist, and the
 * generated feature stylesheet drops its adopter `@import`s. The build then
 * holds host code only, which is exactly what the host ceiling budgets.
 *
 * The adopter's SHIPPED build is still budgeted: its deploy builds its named
 * distribution with `npm run build`, which runs `check-bundle-budget` at the host
 * ceiling plus any declared `entryShareBytes` (capped at 1 kB). That build never
 * sets this flag, and the plugin REFUSES to run under a named distribution, so a
 * shipped bundle can never lose its adopter features to it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const HOST_ONLY_ENV = 'OPENWOP_BUDGET_HOST_ONLY';
/** A path under `src/` no repo writes (leading dot; not a feature root). */
export const NO_ADOPTER_DIR = '/src/.host-only-build-no-adopter/features/';

const GLOB_LITERAL = /(['"`])\/src\/adopter\/features\//g;
const CSS_ADOPTER_IMPORT = /^[ \t]*@import\s+(['"])[^'"\n]*\/adopter\/features\/[^'"\n]*\1[^;\n]*;[ \t]*\r?\n?/gm;

/**
 * The rewrite, pure so it can be tested without a build. Returns the new code,
 * or `null` when the module is untouched.
 */
export function stripAdopter(code, id) {
  const file = id.split('?')[0];
  if (file.includes('/src/adopter/')) return null;
  if (file.endsWith('.css')) {
    const out = code.replace(CSS_ADOPTER_IMPORT, '');
    return out === code ? null : out;
  }
  if (!/\.[cm]?[jt]sx?$/.test(file) || !code.includes('import.meta.glob')) return null;
  const out = code.replace(GLOB_LITERAL, (_m, q) => `${q}${NO_ADOPTER_DIR}`);
  return out === code ? null : out;
}

/**
 * The Vite plugin, or `[]` when the flag is off. `root` is the frontend package dir.
 * Fails the build (never warns) on a named distribution, on a flag value other
 * than `1`, on a rewrite that found nothing in a tree that has adopter features
 * (a renamed literal would silently measure the adopter again), and on ANY
 * `src/adopter/` module that still reached the bundle by another path.
 */
export function hostOnlyPlugin({ env = process.env, distribution = 'default', root }) {
  const flag = env[HOST_ONLY_ENV];
  if (flag === undefined || flag === '') return [];
  if (flag !== '1') throw new Error(`${HOST_ONLY_ENV}=${JSON.stringify(flag)}: only "1" is accepted.`);
  if (distribution !== 'default') {
    throw new Error(`${HOST_ONLY_ENV}=1 with OPENWOP_DISTRIBUTION=${distribution}: a named distribution is a SHIPPED build and must keep its adopter features. The flag is for the budgeted default build only (scripts/ci.sh).`);
  }
  const hasAdopter = existsSync(join(root, 'src', 'adopter', 'features'));
  let rewrites = 0;
  return [{
    name: 'openwop-host-only-budget-build',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      const out = stripAdopter(code, id);
      if (out === null) return null;
      rewrites += 1;
      return { code: out, map: null };
    },
    generateBundle() {
      if (hasAdopter && rewrites === 0) {
        this.error(`${HOST_ONLY_ENV}=1 rewrote nothing, but src/adopter/features/ exists. An adopter glob literal or the feature-stylesheet @import changed shape; update scripts/hostOnlyBuild.mjs.`);
      }
      const leaked = [...this.getModuleIds()].filter((m) => m.split('?')[0].includes('/src/adopter/'));
      if (leaked.length > 0) {
        this.error(`${HOST_ONLY_ENV}=1 but ${leaked.length} adopter module(s) still reached the bundle, e.g. ${leaked[0]}. The host-only build must hold host code only.`);
      }
    },
  }];
}
