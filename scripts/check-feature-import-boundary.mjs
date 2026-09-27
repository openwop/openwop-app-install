#!/usr/bin/env node
/**
 * check-feature-import-boundary (ADR 0630, layer 1 of 3) — the module-graph
 * half of the adopter/steward reachability invariant:
 *
 *   INVARIANT: nothing a distribution excludes, and nothing steward-only, is
 *   reachable from an adopter's build.
 *
 * LAYER 1 (this gate, static): a `features/<id>/…` module may be imported
 * ONLY through the feature registry (`frontend/react/src/features/registry.ts`).
 *
 * WHY. ADR 0366 excludes a feature from a distribution by filtering the
 * registry's static imports so the bundler tree-shakes the package out. That
 * seam is the ONLY exclusion mechanism, and any import of `features/<id>/…`
 * from OUTSIDE the registry bypasses it: the module is reachable from the entry
 * regardless of what the manifest says. MEASURED on `82b803cc5` (#3627): the
 * `kicktodo` manifest of that day excluded `commerce`, `crm`, `docs`, `forms`,
 * `funnels`, `job-search`, and every one of them shipped in the built artifact
 * — three in the ENTRY chunk — because `App.tsx` lazy-imports their public
 * pages directly. `gen-distribution --check` was green throughout: it validates
 * the manifest, and the manifest was fine. The defect is in the graph. (The
 * manifest has since grown the commerce/crm/content bundles; the gate reports
 * what the CURRENT manifests exclude, never a remembered list.)
 *
 * Four verdicts per import, because "reachable" fails in different ways:
 *   - CORE feature (`distributions/bundles.json` `core[]`): permitted. Core is
 *     never excludable, so the import defeats no manifest. Counted, not flagged.
 *   - EXCLUDABLE feature (in the FRONTEND registry, not core): VIOLATION. The
 *     message names the committed distribution(s) whose exclude list the import
 *     defeats — "forms is hard-imported at App.tsx:27 and is EXCLUDED by
 *     kicktodo, no-sales" is actionable in a way "unregistered import" is not.
 *   - FRONTEND-UNREGISTERED (a backend-registered id whose `features/<dir>` has
 *     frontend code but NO `FrontendFeature` entry — docs, podcasts, twin on
 *     2026-09-04): VIOLATION. The frontend filter has nothing to remove, so a
 *     manifest that excludes the feature drops its backend and SHIPS its UI.
 *     MEASURED: `no-sales` excludes `docs` and DocsPublicPage still builds.
 *   - NO REGISTRY ID (neither registry exports `<camel>Feature` for the dir —
 *     site, settings-shell): VIOLATION of a different kind. Nothing can exclude
 *     it because there is nothing to exclude it BY — it is outside the
 *     mechanism, not defeated by it. The gate flags it; the fix (an id) is a
 *     separate change.
 *
 * ALLOWLIST (`scripts/feature-import-boundary.allowlist.json`) — the backlog,
 * not a bypass. The gate landed RED on the existing tree with every violation
 * entered there with an owner and a reason, rather than rewriting them in the
 * same PR to make it green (an empty gate that passes because everything was
 * fixed at 2am is not reviewable). It is SHRINK-ONLY and exact: an entry that no
 * longer matches an import FAILS the gate (stale entries are how allowlists
 * rot into fiction), and a violation not in it fails the gate.
 *
 * SCOPE. Importers OUTSIDE `src/features/` only. Feature→feature imports inside
 * `src/features/` are the ADR 0194 `dependsOn` concern; the frontend has no
 * closure check for them today (MEASURED 2026-09-04: 75 cross-feature edges).
 * That is layer 1b, recorded in ADR 0630 as an open item — not silently folded
 * into this gate's scope, and not silently claimed by it either.
 *
 * Layers 2 (bundle content, post-build) and 3 (tier model, `core` has no
 * steward-only feature) are separate gates that state the SAME invariant in
 * their failure message. See ADR 0630.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-distribution.mjs';
import { isEntryModule } from './lib/entry-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FE_SRC = 'frontend/react/src';
const FE_REGISTRY = `${FE_SRC}/features/registry.ts`;
const BE_REGISTRY = 'backend/typescript/src/features/index.ts';
const ALLOWLIST = join(ROOT, 'scripts', 'feature-import-boundary.allowlist.json');

export const INVARIANT =
  'INVARIANT (ADR 0630): nothing a distribution excludes, and nothing steward-only, is reachable from an adopter\'s build. '
  + 'Layer 1 (module graph): a features/<id> module may be imported only through the feature registry.';

const camelToKebab = (s) => s.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`);

/** Registry `features/<dir>` → feature id, from `import { <camel>Feature } from './<dir>/…'`. */
export function registryDirToId(registrySource) {
  const map = new Map();
  for (const m of registrySource.matchAll(/import \{ (\w+)Feature \} from '\.\/([^/']+)\//g)) {
    map.set(m[2], camelToKebab(m[1]));
  }
  return map;
}

/** Every id a registry exports (`<camel>Feature` reversed) — the same reading
 *  `gen-distribution.mjs` uses, so "registered" means the same thing here. */
export function registryIds(registrySource) {
  const ids = new Set();
  for (const m of registrySource.matchAll(/import \{ (\w+)Feature \}/g)) ids.add(camelToKebab(m[1]));
  return ids;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === '__mocks__') continue;
      yield* walk(p);
    } else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      yield p;
    }
  }
}

// `from '…'`, `import('…')`, and side-effect `import '…'` — every form that puts
// a module in the graph. Relative specifiers only: a `features/…` package import
// does not exist in this tree, and matching bare specifiers would count prose.
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]((?:\.\.?\/)[^'"]*)['"]/g;

/**
 * Every import of a `features/<dir>` module from a file OUTSIDE `src/features/`.
 * Returns [{ file (repo-relative), line, spec, dir }].
 */
export function scanFeatureImports(srcDir, root = ROOT) {
  const featuresDir = resolve(srcDir, 'features');
  const hits = [];
  for (const file of walk(srcDir)) {
    if (resolve(file).startsWith(featuresDir + sep)) continue; // layer 1b, not this gate
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(SPEC_RE)) {
      const target = resolve(dirname(file), m[1]);
      if (!target.startsWith(featuresDir + sep)) continue;
      const parts = relative(featuresDir, target).split(sep);
      if (parts.length < 2) continue; // `features/registry.js`, `features/types.js` — the registry API itself
      const dir = parts[0];
      const line = src.slice(0, m.index).split('\n').length;
      hits.push({ file: relative(root, file).split(sep).join('/'), line, spec: m[1], dir });
    }
  }
  return hits;
}

/** id → distribution names whose generated registries drop it:
 *  { frontend: Map<id, names[]>, backend: Map<id, names[]> }. Kept apart because
 *  a feature with frontend code but no FRONTEND registry entry is excluded on
 *  the backend only — the frontend has nothing to filter, so its UI ships. */
function committedExclusions(root = ROOT) {
  const frontend = new Map();
  const backend = new Map();
  const add = (map, id, name) => { if (!map.has(id)) map.set(id, []); map.get(id).push(name); };
  const dir = join(root, 'distributions');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('__test') || f === 'bundles.json') continue;
    const r = generate(f.replace(/\.json$/, ''), { write: false });
    if (!r.generated) continue;
    for (const id of r.excludedFrontend) add(frontend, id, r.name);
    for (const id of r.excludedBackend) add(backend, id, r.name);
  }
  return { frontend, backend };
}

function loadCatalog(root = ROOT) {
  const p = join(root, 'distributions', 'bundles.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { core: [], bundles: {} };
}

function loadAllowlist(path = ALLOWLIST) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  for (const e of entries) {
    for (const k of ['file', 'feature', 'owner', 'why']) {
      if (typeof e[k] !== 'string' || e[k].trim() === '') {
        throw new Error(`allowlist entry ${JSON.stringify(e)} is missing '${k}' — every entry carries a file, a feature, an owner and a reason`);
      }
    }
  }
  return entries;
}

/**
 * Pure classifier. Everything read from disk arrives as an argument so a test
 * can hand it a fixture:
 *   { imports, dirToId (FE registry dir→id), backendIds (BE registry ids),
 *     core, bundleOf, exclusions: { frontend, backend }, allowlist }.
 * Returns { violations, allowlisted, stale, permittedCore }.
 */
export function classify({ imports, dirToId, backendIds = new Set(), core, bundleOf, exclusions, allowlist }) {
  const coreSet = new Set(core);
  const violations = [];
  const allowlisted = [];
  const permittedCore = [];
  const matched = new Set(); // allowlist index → used
  const tierOf = (id) => (bundleOf.get(id) ? `bundle '${bundleOf.get(id)}'` : 'standalone');
  for (const hit of imports) {
    // A frontend dir maps to its id through the FE registry (`product-discovery`
    // → `discovery`); a dir with frontend code but NO FE registry entry is known
    // only by its backend id, which by convention is the dir name.
    const feId = dirToId.get(hit.dir);
    const id = feId ?? (backendIds.has(hit.dir) ? hit.dir : undefined);
    if (id !== undefined && coreSet.has(id)) {
      permittedCore.push({ ...hit, id });
      continue;
    }
    let kind;
    let detail;
    if (id === undefined) {
      kind = 'unregistered';
      detail = `features/${hit.dir} has NO registry id — no manifest can exclude it (outside the mechanism, not defeated by it; it needs an id before anything else can exclude it)`;
    } else if (feId === undefined) {
      kind = 'frontend-unregistered';
      const by = exclusions.backend.get(id);
      detail = `'${id}' (${tierOf(id)}) has no FRONTEND registry entry — its UI is reachable only through imports like this one, so no manifest can exclude it on the frontend`
        + (by && by.length > 0 ? ` (${by.join(', ')} exclude it on the backend only; the UI ships regardless)` : '');
    } else {
      kind = 'excludable';
      const by = exclusions.frontend.get(id);
      detail = by && by.length > 0
        ? `'${id}' (${tierOf(id)}) is EXCLUDED by ${by.join(', ')} — the import ships it anyway`
        : `'${id}' (${tierOf(id)}) is excludable — any include-mode manifest that does not select it is defeated by this import`;
    }
    const v = { ...hit, id: id ?? null, kind, detail };
    const idx = allowlist.findIndex((e) => e.file === hit.file && e.feature === (id ?? hit.dir));
    if (idx >= 0) {
      matched.add(idx);
      allowlisted.push({ ...v, entry: allowlist[idx] });
    } else {
      violations.push(v);
    }
  }
  const stale = allowlist.filter((_, i) => !matched.has(i));
  return { violations, allowlisted, stale, permittedCore };
}

export function checkFeatureImportBoundary({ root = ROOT, allowlistPath = ALLOWLIST } = {}) {
  const catalog = loadCatalog(root);
  const bundleOf = new Map();
  for (const [name, def] of Object.entries(catalog.bundles ?? {})) {
    for (const f of def.features ?? []) bundleOf.set(f, name);
  }
  return classify({
    imports: scanFeatureImports(join(root, FE_SRC), root),
    dirToId: registryDirToId(readFileSync(join(root, FE_REGISTRY), 'utf8')),
    backendIds: registryIds(readFileSync(join(root, BE_REGISTRY), 'utf8')),
    core: catalog.core ?? [],
    bundleOf,
    exclusions: committedExclusions(root),
    allowlist: loadAllowlist(allowlistPath),
  });
}

export function formatReport(r) {
  const lines = [];
  const fmt = (v) => `  ✗ ${v.file}:${v.line} imports ${v.spec.replace(/^(\.\.?\/)+/, '')} — ${v.detail}`;
  if (r.violations.length > 0) {
    lines.push(`${r.violations.length} feature import(s) outside the registry are NOT allowlisted:`);
    for (const v of r.violations) lines.push(fmt(v));
    lines.push('  Route the module through the registry (or give the feature an id), or — for a deliberate deferral — add an allowlist entry WITH an owner and a reason.');
  }
  if (r.stale.length > 0) {
    lines.push(`${r.stale.length} allowlist entr${r.stale.length === 1 ? 'y' : 'ies'} match(es) nothing — the import was fixed or moved; remove the entry (the allowlist is shrink-only and exact):`);
    for (const e of r.stale) lines.push(`  ✗ ${e.file} × '${e.feature}' (owner ${e.owner})`);
  }
  return lines.join('\n');
}

if (isEntryModule(import.meta.url)) {
  const list = process.argv.includes('--list');
  let r;
  try {
    // OPENWOP_BOUNDARY_ALLOWLIST: a test seam only — points the gate at another
    // allowlist so a test can prove the gate goes RED on the real tree (an empty
    // allowlist must fail). Unset in every normal invocation.
    const allowlistPath = process.env.OPENWOP_BOUNDARY_ALLOWLIST || ALLOWLIST;
    r = checkFeatureImportBoundary({ allowlistPath });
  } catch (err) {
    console.error(`check-feature-import-boundary: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (list) {
    for (const v of [...r.allowlisted, ...r.violations]) {
      console.log(`${v.file}:${v.line} ${v.kind} ${v.id ?? v.dir} ${v.entry ? `[allowlisted: ${v.entry.owner}]` : '[NOT allowlisted]'}`);
    }
  }
  const failed = r.violations.length > 0 || r.stale.length > 0;
  if (failed) {
    console.error(INVARIANT);
    console.error(formatReport(r));
    process.exit(1);
  }
  const files = new Set(r.allowlisted.map((v) => v.file)).size;
  console.log(
    `✓ check-feature-import-boundary: 0 unallowlisted feature imports outside the registry; `
    + `${r.allowlisted.length} allowlisted (the ADR 0630 backlog, ${files} file(s)); ${r.permittedCore.length} core-feature import(s) permitted.`,
  );
}
