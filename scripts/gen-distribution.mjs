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

/** Every feature id registered in either canonical registry (via the
 *  `<camelId>Feature` convention, reversed). */
function registeredFeatureIds() {
  const ids = new Set();
  for (const file of [BE_REGISTRY, FE_REGISTRY]) {
    for (const m of readFileSync(file, 'utf8').matchAll(/import \{ (\w+)Feature \}/g)) {
      ids.add(m[1].replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`));
    }
  }
  return ids;
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
    const exclude = [...registeredFeatureIds()].filter((f) => !core.has(f) && !included.has(f)).sort();
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

/** Backend feature packages that declare NO primary `toggleDefault:` property —
 *  always-on substrate (graduated off their toggle, ADR 0027). Matches the
 *  PROPERTY (`toggleDefault:`), not the bare word — a comment ("No toggleDefault")
 *  or an imperative `registerToggleDefault(...)` call (e.g. cms) must NOT count
 *  as declaring one, mirroring the runtime `if (feature.toggleDefault)` check. */
function alwaysOnFeatureIds() {
  const ids = new Set();
  for (const dir of readdirSync(BE_FEATURES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = join(BE_FEATURES_DIR, dir.name, 'feature.ts');
    if (!existsSync(f)) continue;
    if (!/\btoggleDefault\s*:/.test(readFileSync(f, 'utf8'))) ids.add(dir.name);
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
  const core = new Set(catalog.core ?? []);
  const errors = [];
  for (const f of core) {
    if (!registered.has(f)) errors.push(`core names unregistered feature '${f}'`);
  }
  const seen = new Map(); // feature id → where first seen
  for (const f of core) seen.set(f, 'core');
  for (const [bundle, def] of Object.entries(catalog.bundles)) {
    for (const f of def.features) {
      if (!registered.has(f)) errors.push(`bundle '${bundle}' names unregistered feature '${f}'`);
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
      console.log('✓ bundle catalog: core dependsOn-closed, always-on ⊆ core, no overlap, all ids resolve');
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
