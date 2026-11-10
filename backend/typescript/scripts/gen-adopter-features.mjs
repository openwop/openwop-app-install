#!/usr/bin/env node
/**
 * gen-adopter-features (ADR 1031 P1) — the BACKEND half of the adopter feature seam.
 *
 * An adopter repo (a white-label downstream such as KickTodo) registers its own
 * feature packages from paths openwop-app never writes:
 *
 *   backend/typescript/src/adopter/features/<id>/feature.ts   exports `<camelId>Feature`
 *   backend/typescript/src/adopter/packPins.ts                 exports `ADOPTER_PACK_PINS` (optional)
 *
 * The frontend discovers its half with `import.meta.glob`. Node has no glob import
 * and esbuild bundles static imports only, so this script turns the directory
 * listing into two STATIC modules, both gitignored and never committed:
 *
 *   src/features/adopterFeatures.generated.ts   ADOPTER_BACKEND_FEATURES (+ their dir ids)
 *   src/features/adopterPackPins.generated.ts   ADOPTER_PACK_PINS
 *
 * In openwop-app itself there is no `src/adopter/`, so both modules are EMPTY and
 * the composed registry is byte-for-byte the first-party one (ADR 1031: zero
 * behavior change upstream).
 *
 * It lives INSIDE `backend/typescript/` on purpose: the Cloud Run image is built
 * from that subtree only (Dockerfile `COPY backend/typescript/scripts`), and
 * `scripts/build.mjs` runs it before esbuild, so adopter features reach the image.
 *
 * Who runs it (every entry point that compiles or loads `src/features/index.ts`):
 * `scripts/build.mjs` (npm run build, the Docker build), `predev`, `pretest`,
 * `pretypecheck`, `prelint`, `pretest:conformance`, and `vitest.config.ts` at
 * config load (so a bare `vitest run` cannot see a stale file). A write happens
 * only when the content changed, via a temp file + rename, so concurrent
 * generators never observe a half-written module.
 *
 * Fails LOUD, never a silent partial registration:
 *  - a directory under `src/adopter/features/` that is not a kebab-case id;
 *  - a feature directory with no `feature.ts`;
 *  - a `feature.ts` that does not export `<camelId>Feature`;
 *  - a `packPins.ts` that does not export `ADOPTER_PACK_PINS`.
 * Duplicate ids (adopter vs first-party) are a BOOT error, not a generator one —
 * see `src/features/composeFeatures.ts`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A feature id: kebab-case, starting with a letter (same shape as first-party ids). */
export const ADOPTER_FEATURE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const GENERATED_FEATURES_REL = 'src/features/adopterFeatures.generated.ts';
export const GENERATED_PINS_REL = 'src/features/adopterPackPins.generated.ts';
export const ADOPTER_FEATURES_REL = 'src/adopter/features';
export const ADOPTER_PACK_PINS_REL = 'src/adopter/packPins.ts';

const camel = (kebab) => kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
/** `<id>` → the export the feature module must declare (`kicktodo-core` → `kicktodoCoreFeature`). */
export const adopterExportName = (id) => `${camel(id)}Feature`;

function exportsName(src, name) {
  return new RegExp(`\\bexport\\s+(?:const|let|var|function)\\s+${name}\\b`).test(src)
    || new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(src);
}

/**
 * Every adopter backend feature under `<pkgRoot>/src/adopter/features/`, sorted by id.
 * Returns `[{ id, exportName, importPath }]`; `[]` when the directory is absent.
 */
export function scanAdopterBackendFeatures(pkgRoot = PKG_ROOT) {
  const root = join(pkgRoot, ADOPTER_FEATURES_REL);
  if (!existsSync(root)) return [];
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === '__tests__') continue;
    if (!ADOPTER_FEATURE_ID_RE.test(e.name)) {
      throw new Error(`adopter feature directory '${e.name}' is not a kebab-case feature id (${ADOPTER_FEATURES_REL}/${e.name}) — the directory name IS the feature id`);
    }
    const file = join(root, e.name, 'feature.ts');
    if (!existsSync(file)) {
      throw new Error(`adopter feature '${e.name}' has no feature.ts (${ADOPTER_FEATURES_REL}/${e.name}/feature.ts) — every backend adopter feature exports its BackendFeature there`);
    }
    const exportName = adopterExportName(e.name);
    if (!exportsName(readFileSync(file, 'utf8'), exportName)) {
      throw new Error(`adopter feature '${e.name}': ${ADOPTER_FEATURES_REL}/${e.name}/feature.ts must export \`${exportName}\` (the <camelId>Feature convention first-party features follow)`);
    }
    out.push({ id: e.name, exportName, importPath: `../adopter/features/${e.name}/feature.js` });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** True when the adopter ships a pin file. Throws when it exists but does not export the pins. */
export function hasAdopterPackPins(pkgRoot = PKG_ROOT) {
  const file = join(pkgRoot, ADOPTER_PACK_PINS_REL);
  if (!existsSync(file)) return false;
  if (!exportsName(readFileSync(file, 'utf8'), 'ADOPTER_PACK_PINS')) {
    throw new Error(`${ADOPTER_PACK_PINS_REL} must export \`ADOPTER_PACK_PINS\` (a Record<packName, version>)`);
  }
  return true;
}

/**
 * `dependsOn` edges of every adopter backend feature (string literals only — the
 * same declared shape `scripts/gen-distribution.mjs` reads for first-party features).
 */
export function adopterDependsOn(pkgRoot = PKG_ROOT) {
  const edges = {};
  for (const f of scanAdopterBackendFeatures(pkgRoot)) {
    const src = readFileSync(join(pkgRoot, ADOPTER_FEATURES_REL, f.id, 'feature.ts'), 'utf8');
    const m = src.match(/dependsOn:\s*\[([^\]]*)\]/);
    edges[f.id] = m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
  }
  return edges;
}

const BANNER = '// GENERATED by backend/typescript/scripts/gen-adopter-features.mjs (ADR 1031) — DO NOT EDIT, DO NOT COMMIT.\n'
  + '// Source: src/adopter/features/*/feature.ts and src/adopter/packPins.ts. Empty in openwop-app itself.\n';

export function renderFeaturesModule(features) {
  const imports = features.map((f) => `import { ${f.exportName} } from '${f.importPath}';\n`).join('');
  return BANNER
    + "import type { BackendFeature } from './types.js';\n"
    + imports
    + '\n/** Adopter feature directory ids, index-aligned with ADOPTER_BACKEND_FEATURES (checked at boot). */\n'
    + `export const ADOPTER_FEATURE_DIRS: readonly string[] = [${features.map((f) => `'${f.id}'`).join(', ')}];\n`
    + '/** Adopter backend features, appended after the first-party ones in BACKEND_FEATURES. */\n'
    + `export const ADOPTER_BACKEND_FEATURES: readonly BackendFeature[] = [${features.map((f) => f.exportName).join(', ')}];\n`;
}

export function renderPinsModule(withPins) {
  return BANNER + (withPins
    // Re-declared at the wide type, so an adopter's `as const` literal is checked
    // against Record<string, string> here and indexable by any pack name in packPins.ts.
    ? "import { ADOPTER_PACK_PINS as ADOPTER_DECLARED_PINS } from '../adopter/packPins.js';\n\n"
      + 'export const ADOPTER_PACK_PINS: Readonly<Record<string, string>> = ADOPTER_DECLARED_PINS;\n'
    : '/** Pack pins the adopter declares in src/adopter/packPins.ts — none here. */\n'
      + 'export const ADOPTER_PACK_PINS: Readonly<Record<string, string>> = {};\n');
}

/** Write `content` to `file` only when it differs, atomically. Returns whether it wrote. */
function writeIfChanged(file, content) {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  return true;
}

/**
 * Generate both modules for `pkgRoot`. With `write: false` nothing touches disk;
 * the sources are returned so a caller (or a test) can inspect them.
 */
export function generateAdopterFeatures({ pkgRoot = PKG_ROOT, write = true } = {}) {
  const features = scanAdopterBackendFeatures(pkgRoot);
  const withPins = hasAdopterPackPins(pkgRoot);
  const featuresSource = renderFeaturesModule(features);
  const pinsSource = renderPinsModule(withPins);
  let changed = false;
  if (write) {
    changed = writeIfChanged(join(pkgRoot, GENERATED_FEATURES_REL), featuresSource) || changed;
    changed = writeIfChanged(join(pkgRoot, GENERATED_PINS_REL), pinsSource) || changed;
  }
  return { features: features.map((f) => f.id), withPins, featuresSource, pinsSource, changed };
}

// realpath both sides: `import.meta.url` is realpath-resolved and argv[1] is not
// (the #3070 class `scripts/lib/entry-module.mjs` documents; that helper is outside
// the backend subtree the Docker build copies, so it is inlined here).
const invokedDirectly = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  try {
    const r = generateAdopterFeatures();
    if (process.argv.includes('--verbose') || r.features.length > 0) {
      console.log(`adopter features: ${r.features.length ? r.features.join(', ') : 'none'}${r.withPins ? ' (+ adopter pack pins)' : ''}${r.changed ? '' : ' (unchanged)'}`);
    }
  } catch (err) {
    console.error(`gen-adopter-features: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
