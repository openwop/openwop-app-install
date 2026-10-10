#!/usr/bin/env node
/**
 * gen-distribution (ADR 0366 Phase 1) — generate per-distribution registry
 * modules so excluded first-party features TREE-SHAKE out of both artifacts.
 *
 * Mechanism (the architect-gate ruling): a runtime filter cannot drop code —
 * only the registry module's STATIC imports can. This script reads the
 * distribution manifest (`distributions/<name>.json`, named by
 * OPENWOP_DISTRIBUTION), filters the two canonical registry files by the
 * `<kebab-id>` → `<camelId>Feature` convention, and writes gitignored
 * `*.distribution.ts` siblings the build ALIASES in (P1b wires the aliases;
 * default = no generation, checked-in registries used byte-identically).
 *
 * Gates (all fail the build loudly — never a silent partial exclusion):
 *  - every excluded id must resolve in at least one registry (convention
 *    drift or a typo is an error, not a no-op);
 *  - the ADR 0194 dependsOn closure must hold: excluding a feature that an
 *    INCLUDED feature hard-depends on fails with the dependent list;
 *  - `--check` mode validates every manifest without writing (the CI gate).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BE_REGISTRY = join(ROOT, 'backend/typescript/src/features/index.ts');
const FE_REGISTRY = join(ROOT, 'frontend/react/src/features/registry.ts');
const BE_FEATURES_DIR = join(ROOT, 'backend/typescript/src/features');

const camel = (kebab) => kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const varName = (id) => `${camel(id)}Feature`;

function loadBundles() {
  const p = join(ROOT, 'distributions', 'bundles.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { bundles: {} };
}

const kebab = (camelId) => camelId.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`);

/** `{ id, source }` for every `import { <camelId>Feature } from '<path>'` in a
 *  registry — the id by the `<camelId>Feature` convention (reversed), the source
 *  file resolved from the import path (`.js` → `.ts`/`.tsx`). The SOURCE is what
 *  lets the always-on rule see a FILE-based feature (`features/x.ts`) as well as
 *  a directory one (core-audit M10). */
function registryEntries(file) {
  const out = [];
  for (const m of readFileSync(file, 'utf8').matchAll(/import \{ (\w+)Feature \} from '([^']+)'/g)) {
    const base = join(dirname(file), m[2]).replace(/\.js$/, '');
    const source = [`${base}.ts`, `${base}.tsx`].find((p) => existsSync(p));
    out.push({ id: kebab(m[1]), source });
  }
  return out;
}

/** Every feature id registered in either canonical registry (via the
 *  `<camelId>Feature` convention, reversed). */
function registeredFeatureIds() {
  const ids = new Set();
  for (const file of [BE_REGISTRY, FE_REGISTRY]) {
    for (const e of registryEntries(file)) ids.add(e.id);
  }
  return ids;
}

/** Every non-test `.ts` file under `dir`. */
function tsFilesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFilesUnder(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** The `[...]` text that follows `key: [` in `src`, bracket-matched (one level
 *  of nested `[]` inside a ToggleConfig — e.g. `variants` — must not end it). */
function bracketBody(src, key) {
  const at = src.search(new RegExp(`\\b${key}\\s*:\\s*\\[`));
  if (at < 0) return '';
  let i = src.indexOf('[', at);
  const start = i + 1;
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) return src.slice(start, i);
  }
  return '';
}

/**
 * ADR 0820 §1 alternative (b) / §4 "check needed" — the TOGGLE catalog, read from
 * source: toggle id → the backend feature directory that registers it. Three
 * declaration shapes count, mirroring what `registerBackendFeatures` registers at
 * boot: a primary `toggleDefault: { id }`, an `extraToggleDefaults: [{ id }, …]`
 * entry, and an imperative `registerToggleDefault({ id: '…' })` anywhere in the
 * feature's directory (cms, commerce, app-builder). String-literal ids only — a
 * constant id (strategy's approval gate) is invisible here, which only means such
 * a toggle cannot be named in a bundle until it is spelled literally.
 */
export function toggleCatalog() {
  const parentOf = new Map();
  for (const dir of readdirSync(BE_FEATURES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = join(BE_FEATURES_DIR, dir.name);
    for (const f of tsFilesUnder(root)) {
      const src = readFileSync(f, 'utf8');
      const ids = [];
      for (const m of src.matchAll(/registerToggleDefault\(\{\s*id:\s*'([^']+)'/g)) ids.push(m[1]);
      if (f === join(root, 'feature.ts')) {
        const primary = /\btoggleDefault\s*:\s*\{[^}]*?\bid:\s*'([^']+)'/.exec(src);
        if (primary) ids.push(primary[1]);
        for (const m of bracketBody(src, 'extraToggleDefaults').matchAll(/\bid:\s*'([^']+)'/g)) ids.push(m[1]);
      }
      for (const id of ids) if (!parentOf.has(id)) parentOf.set(id, dir.name);
    }
  }
  return parentOf;
}

/** Sub-toggle ids (ADR 0820 §4): a registered TOGGLE id that is not itself a
 *  registered FEATURE id — `code-export` (app-builder), `service-desk.widget`
 *  (service-desk). Maps id → its parent feature. A sub-toggle is a valid bundle
 *  member: it strips NOTHING on its own (it lives inside its parent package), so
 *  it only ever changes what the paywall gates, never what a build contains. */
export function subToggleParents(registered = registeredFeatureIds()) {
  const out = new Map();
  for (const [id, parent] of toggleCatalog()) if (!registered.has(id)) out.set(id, parent);
  return out;
}

function loadManifest(name) {
  const p = join(ROOT, 'distributions', `${name}.json`);
  if (!existsSync(p)) throw new Error(`no such distribution manifest: ${p}`);
  const m = JSON.parse(readFileSync(p, 'utf8'));
  if (Array.isArray(m.exclude)) return m; // Phase-1 exclude semantics
  // Phase-2 include semantics (the licensing-safe direction): the build is
  // CORE (everything unbundled) + the named bundles/features; every OTHER
  // bundled feature is excluded — a NEW feature added to a bundle later
  // does not silently ship to existing include-mode distributions.
  if (Array.isArray(m.bundles) || Array.isArray(m.features)) {
    const catalog = loadBundles();
    const included = new Set(m.features ?? []);
    for (const b of m.bundles ?? []) {
      const def = catalog.bundles[b];
      if (!def) throw new Error(`${name}: unknown bundle '${b}'`);
      for (const f of def.features) included.add(f);
    }
    // Phase-4 excludable universe = registered − core. EVERY non-core feature
    // is composable (bundled OR standalone); a standalone feature defaults OUT
    // and is opted IN via `features[]` (correction to P2's `allBundled` — which
    // silently kept every unbundled feature in). `core` is never excludable.
    const core = new Set(catalog.core ?? []);
    const registered = registeredFeatureIds();
    // A sub-toggle strips nothing, so it never joins the excludable universe —
    // but naming one whose PARENT the build drops is a manifest that sells a
    // capability it does not ship. Loud, never a silent no-op.
    const subs = subToggleParents(registered);
    const orphaned = [...included].filter((f) => subs.has(f) && !core.has(subs.get(f)) && !included.has(subs.get(f)));
    if (orphaned.length > 0) {
      throw new Error(`${name}: sub-toggle(s) included without their parent feature: ${orphaned.map((f) => `'${f}' (parent '${subs.get(f)}')`).join(', ')}`);
    }
    const exclude = [...registered].filter((f) => !core.has(f) && !included.has(f)).sort();
    return { ...m, exclude };
  }
  throw new Error(`${name}: manifest must carry exclude[] (Phase 1) or bundles[]/features[] (Phase 2)`);
}

/** Backend feature.ts `dependsOn` edges (string literals only). */
function backendDependsOn() {
  const edges = {};
  for (const dir of readdirSync(BE_FEATURES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = join(BE_FEATURES_DIR, dir.name, 'feature.ts');
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/dependsOn:\s*\[([^\]]*)\]/);
    edges[dir.name] = m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
  }
  return edges;
}

/**
 * FRONTEND-only features allowed to be always-on (no toggle gates them) without
 * being core. The always-on ⊆ core rule exists because an ungated BACKEND feature
 * is boot substrate; an ungated frontend page is not, so a page may legitimately
 * be opt-in per distribution. Each entry is a reviewed claim — add one only with
 * the reason it is safe to exclude.
 */
const FRONTEND_ALWAYS_ON_STANDALONE = {
  // The public `/showcase` marketing page (`tier: 'site'`). Demo content, no
  // backend, nothing imports it: a distribution opts in to it or ships without.
  showcase: 'public demo page — opt-in per distribution, nothing depends on it',
};

/** Feature ids that are ALWAYS-ON — no toggle can switch them off — read from
 *  the registries, so every registered feature is seen whatever its file shape
 *  (core-audit M10: the earlier directory scan missed the file-based
 *  `features/widgets.ts` and every frontend-only feature).
 *   - BACKEND: the registered source declares no primary `toggleDefault:`
 *     PROPERTY (graduated off its toggle, ADR 0027). Matches the PROPERTY, not
 *     the bare word — a comment ("No toggleDefault") or an imperative
 *     `registerToggleDefault(...)` call (e.g. cms) must NOT count as declaring
 *     one, mirroring the runtime `if (feature.toggleDefault)` check.
 *   - FRONTEND-only (no backend entry of the same id): neither the feature's
 *     declared `id:` nor any route's `featureId:` names a registered toggle —
 *     nothing in the toggle catalog can hide it. */
function alwaysOnFeatureIds() {
  const ids = new Set();
  const backend = new Set();
  for (const { id, source } of registryEntries(BE_REGISTRY)) {
    backend.add(id);
    if (source && !/\btoggleDefault\s*:/.test(readFileSync(source, 'utf8'))) ids.add(id);
  }
  const toggles = toggleCatalog();
  for (const { id, source } of registryEntries(FE_REGISTRY)) {
    if (backend.has(id) || !source || Object.hasOwn(FRONTEND_ALWAYS_ON_STANDALONE, id)) continue;
    const src = readFileSync(source, 'utf8');
    const named = [...src.matchAll(/\b(?:featureId|id):\s*'([^']+)'/g)].map((m) => m[1]);
    if (!named.some((t) => toggles.has(t))) ids.add(id);
  }
  return ids;
}

/** Phase-4 catalog invariants — a bad catalog would let the shop offer an
 *  un-buildable exclusion, so every one is a loud `--check` failure:
 *   - every core id + bundle feature id is REGISTERED (drift);
 *   - no id is in two places (core∩bundle, or two bundles);
 *   - `core` is dependsOn-CLOSED: no core feature hard-depends on a non-core
 *     one — so every bundle/standalone the shop offers is actually excludable
 *     (the architect-gate ruling: the taxonomy must respect the dep graph);
 *   - an ALWAYS-ON feature (no toggleDefault) MUST be core — else it becomes
 *     excludable and a slim build drops boot-critical substrate;
 *   - a bundle whose NAME is also a registered feature id MUST contain that
 *     feature. Bundle names and feature ids are different namespaces, so the
 *     "no id is in two places" rule above is satisfied by a collision and
 *     cannot see it. When such a bundle does NOT contain its namesake, a
 *     manifest author who writes `bundles: ["x"]` meaning the FEATURE `x`
 *     silently gets a different set — no error, no warning, wrong build.
 *     A self-CONTAINING collision is harmless (selecting the bundle also
 *     grants the feature), which is why the invariant is containment rather
 *     than a blanket ban on the name being reused. */
export function checkBundleCatalog(catalogOverride) {
  const catalog = catalogOverride ?? loadBundles();
  const registered = registeredFeatureIds();
  const subs = subToggleParents(registered);
  const core = new Set(catalog.core ?? []);
  const errors = [];
  for (const f of core) {
    if (subs.has(f)) {
      if (!core.has(subs.get(f))) errors.push(`core names sub-toggle '${f}' whose parent feature '${subs.get(f)}' is not core`);
    } else if (!registered.has(f)) errors.push(`core names unregistered feature '${f}'`);
  }
  const seen = new Map(); // feature id → where first seen
  for (const f of core) seen.set(f, 'core');
  for (const [bundle, def] of Object.entries(catalog.bundles)) {
    for (const f of def.features) {
      // ADR 0820 §4 — a sub-toggle id is a valid member when its PARENT ships
      // whenever the bundle does (same bundle, or core). It strips nothing on its
      // own; it is there so the paywall gates it with the bundle.
      if (subs.has(f)) {
        const parent = subs.get(f);
        if (!core.has(parent) && !def.features.includes(parent)) {
          errors.push(`bundle '${bundle}' names sub-toggle '${f}' but not its parent feature '${parent}' (put '${parent}' in the same bundle or core)`);
        }
      } else if (!registered.has(f)) errors.push(`bundle '${bundle}' names unregistered feature '${f}'`);
      const prior = seen.get(f);
      if (prior) errors.push(`feature '${f}' is in both ${prior} and bundle '${bundle}' (a feature belongs to exactly one place)`);
      else seen.set(f, `bundle '${bundle}'`);
    }
  }
  const deps = backendDependsOn();
  for (const f of core) {
    for (const d of deps[f] ?? []) {
      if (!core.has(d)) errors.push(`core '${f}' hard-depends on non-core '${d}' — core must be dependsOn-closed (add '${d}' to core)`);
    }
  }
  for (const f of alwaysOnFeatureIds()) {
    if (!core.has(f)) errors.push(`always-on feature '${f}' (no toggleDefault) MUST be in core — it cannot be excludable`);
  }
  // ADR 0820 §7 UI — the store groups bundle cards by DATA: `groups` is the
  // ordered list of goal-group ids, and a bundle's optional `group` must name
  // one of them. An undeclared or malformed group would render an orphan
  // heading with no label, so it is a loud failure here, not a UI fallback.
  const GROUP_RE = /^[a-z][a-z0-9-]*$/;
  const groups = catalog.groups;
  if (groups !== undefined && (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string' || !GROUP_RE.test(g)))) {
    errors.push('`groups` must be an array of kebab-case group ids');
  } else if (Array.isArray(groups) && new Set(groups).size !== groups.length) {
    errors.push('`groups` lists a group id twice');
  }
  const declared = new Set(Array.isArray(groups) ? groups : []);
  for (const [bundle, def] of Object.entries(catalog.bundles)) {
    if (def.group === undefined) continue;
    if (typeof def.group !== 'string' || !declared.has(def.group)) {
      errors.push(`bundle '${bundle}' names group '${String(def.group)}', which is not declared in \`groups\``);
    }
  }
  for (const [bundle, def] of Object.entries(catalog.bundles)) {
    if (!registered.has(bundle) || def.features.includes(bundle)) continue;
    errors.push(
      `bundle '${bundle}' shares its name with a registered feature but does not contain it — `
      + `selecting it grants [${def.features.join(', ')}] instead. Rename the bundle, or add '${bundle}' to it.`,
    );
  }
  return errors;
}

/** dependsOn closure: for every INCLUDED backend feature, its hard deps must
 *  not be excluded. Parses `dependsOn: [...]` from each feature.ts (string
 *  literals only — the declared shape). */
function checkClosure(excluded) {
  const violations = [];
  for (const dir of readdirSync(BE_FEATURES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory() || excluded.has(dir.name)) continue;
    const f = join(BE_FEATURES_DIR, dir.name, 'feature.ts');
    if (!existsSync(f)) continue;
    const src = readFileSync(f, 'utf8');
    const m = src.match(/dependsOn:\s*\[([^\]]*)\]/);
    if (!m) continue;
    for (const dep of m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)) {
      if (excluded.has(dep)) violations.push(`'${dir.name}' (included) hard-depends on '${dep}' (excluded)`);
    }
  }
  return violations;
}

/** Remove each excluded feature's import line + array entry from a registry
 *  source. Returns { out, found } — found lists ids that matched this file. */
function filterRegistry(src, excludedIds) {
  let out = src;
  const found = [];
  for (const id of excludedIds) {
    const v = varName(id);
    const importRe = new RegExp(`^import \\{[^}]*\\b${v}\\b[^}]*\\} from '[^']+';\\n`, 'm');
    const entryRe = new RegExp(`\\b${v}\\b,?\\s*`);
    if (importRe.test(out)) {
      out = out.replace(importRe, '');
      out = out.replace(entryRe, '');
      found.push(id);
    }
  }
  return { out, found };
}

export function generate(name, { write = true } = {}) {
  const manifest = loadManifest(name);
  const excluded = new Set(manifest.exclude);
  if (excluded.size === 0) {
    return { name, generated: false, reason: 'empty exclude list — the checked-in registries are the build' };
  }
  const closure = checkClosure(excluded);
  if (closure.length > 0) {
    throw new Error(`distribution '${name}' violates the dependsOn closure:\n  ${closure.join('\n  ')}`);
  }
  const be = filterRegistry(readFileSync(BE_REGISTRY, 'utf8'), manifest.exclude);
  const fe = filterRegistry(readFileSync(FE_REGISTRY, 'utf8'), manifest.exclude);
  const resolved = new Set([...be.found, ...fe.found]);
  const unresolved = manifest.exclude.filter((id) => !resolved.has(id));
  if (unresolved.length > 0) {
    throw new Error(`distribution '${name}': excluded id(s) resolve in NEITHER registry (typo or convention drift): ${unresolved.join(', ')}`);
  }
  const banner = `// GENERATED by scripts/gen-distribution.mjs for distribution '${name}' — DO NOT EDIT, DO NOT COMMIT.\n`;
  if (write) {
    writeFileSync(BE_REGISTRY.replace(/\.ts$/, '.distribution.ts'), banner + be.out);
    writeFileSync(FE_REGISTRY.replace(/\.ts$/, '.distribution.ts'), banner + fe.out);
  }
  // Return the SOURCE, not just the id lists, so a caller can substitute it
  // in memory and never touch the gitignored artifact. The frontend build does
  // exactly that — see vite.config.ts. A file on disk can be stale; a string
  // computed from the manifest during this build cannot.
  return {
    name,
    generated: true,
    excludedBackend: be.found,
    excludedFrontend: fe.found,
    backendSource: banner + be.out,
    frontendSource: banner + fe.out,
  };
}

// MEASURED BROKEN before this (#3070 class): `fileURLToPath(import.meta.url)` is
// realpath-resolved and `process.argv[1]` is not, so invoking this script by an
// absolute symlinked path made `isMain` false — and `--check` then exited 0
// having validated NOTHING. `ci:distribution` runs exactly that command — though
// nothing invoked `ci:distribution` either until `scripts/ci.sh` began running
// `--check` directly; the command being named was never the command being run. So the
// gate could not fail. It only ever worked because the usual invocation is a
// RELATIVE path and `process.cwd()` is already realpath-resolved.
const isMain = isEntryModule(import.meta.url);
if (isMain) {
  const check = process.argv.includes('--check');
  try {
    if (check) {
      const catErrors = checkBundleCatalog();
      if (catErrors.length > 0) throw new Error(`bundle catalog invalid:\n  ${catErrors.join('\n  ')}`);
      console.log('✓ bundle catalog: core dependsOn-closed, always-on ⊆ core (backend, file-based + frontend-only), no overlap, all ids resolve (sub-toggles ride their parent)');
      for (const f of readdirSync(join(ROOT, 'distributions')).filter((f) => f.endsWith('.json') && !f.startsWith('__test') && f !== 'bundles.json')) {
        const r = generate(f.replace(/\.json$/, ''), { write: false });
        console.log(`✓ ${r.name}: ${r.generated ? `excludes BE ${r.excludedBackend.length} / FE ${r.excludedFrontend.length}` : r.reason}`);
      }
    } else {
      const name = process.env.OPENWOP_DISTRIBUTION ?? 'default';
      const r = generate(name);
      console.log(r.generated ? `generated distribution '${r.name}' registries` : `distribution '${r.name}': ${r.reason}`);
    }
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
