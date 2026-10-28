/**
 * Node-catalog builder — the SINGLE source of the host's resolvable node menu,
 * shared by the builder-palette route (`routes/nodeCatalog.ts`) and the AI
 * workflow-author feature (ADR 0072), so the authoring brain plans against the
 * exact same closed-world catalog the palette renders.
 *
 * Returns every resolvable node typeId on this host: the locally-registered
 * sample modules + any node declared in a pack manifest under OPENWOP_PACK_DIR.
 * Metadata only — no executable code. Schema refs (config/input/output) are read
 * from pack.json and inlined when small (<8kb each); larger schemas are flagged
 * (`$ref` + `_note`) rather than inlined.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { requiredHostSurfacesFor } from '../bootstrap/hostSurfaceMap.js';
import { registeredFeatureSurfaceIds, disabledFeatureSurfacesFor } from './featureSurfaces.js';
import { listHostSurfaces } from '../bootstrap/hostSurfaceRegistry.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { isTombstoned } from './packTombstones.js';
import { isParkedPackDirName } from '../bootstrap/mountLocalPacks.js';
import { matchedLocalizationTag, resolveLocalizedValues } from './i18n/resolveSection.js';

const MAX_SCHEMA_INLINE_BYTES = 8 * 1024;

export interface CatalogNode {
  typeId: string;
  /** Absent when neither the pack row nor a registered module declares one
   *  (grade-code C-14: typed honestly, so a caller that pins or compares versions
   *  must handle "unknown" rather than read `undefined` as a string). */
  version?: string;
  label: string;
  description: string;
  category: string;
  role?: string;
  capabilities?: readonly string[];
  /** Source: 'local' for in-process modules, 'pack' for registry packs. */
  source: 'local' | 'pack';
  /** Pack name when source='pack'. */
  packName?: string;
  configSchema?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** ADR 0782 — the pack author's builder-port intent, from the node entry's
   *  RFC 0138 `x-ports` hint. `single` = ONE input port whatever the input
   *  schema's `required` says. Absent = the builder's default derivation. Only
   *  a recognised value is served. */
  ports?: 'single';
  /** Host surfaces this node needs to execute (e.g., `host.kvStorage`). Empty
   *  means no host surface required (pure data / control nodes). */
  requiresHostSurfaces: string[];
  /** Subset of `requiresHostSurfaces` this host does NOT advertise. Empty means
   *  the node is runnable here. */
  missingHostSurfaces: string[];
  /** ADR 0917 (Book AI P12) — the FEATURE surfaces (`ctx.features.<id>`) the
   *  node reads, from the manifest's `x-requiresFeatureSurfaces`. Each also
   *  appears in `requiresHostSurfaces` as `host.sample.<id>` (the capability the
   *  seam's refusal names), and in `missingHostSurfaces` when this host does not
   *  compose the feature, or (on the per-tenant catalog route) the tenant has
   *  it off. */
  requiresFeatureSurfaces?: string[];
  /** ADR 0937 (Book AI SRV-2) — per-locale `label`/`description` overlays from
   *  the manifest entry's `x-localizations` (RFC 0138 hatch), keyed by BCP-47
   *  tag. The catalog route resolves them for the request's `Accept-Language`
   *  ({@link localizeCatalogNode}); the base fields stay the pack's own text. */
  localizations?: Record<string, { label?: string; description?: string }>;
  /** RFC 0031 §B — model-capability identifiers this NodeModule depends on. */
  requiredModelCapabilities?: string[];
  /** RFC 0031 §B — host-substitution coordinates when the active model can't
   *  satisfy `requiredModelCapabilities`. */
  fallbackModel?: { provider: string; model: string };
}

interface PackManifestNode {
  typeId: string;
  version?: string;
  label?: string;
  description?: string;
  category?: string;
  /** NP-V2 P5 — the builder palette's grouping when it is finer than the spec
   *  `category` enum (`chat|control|data|canvas|coordination|integration`), which
   *  has no `flow` or `ai`. Carried through the RFC 0138 `x-` extension hatch so
   *  the manifest stays v2-valid and the palette does not move. */
  'x-paletteCategory'?: string;
  /** ADR 0782 — builder-port intent (RFC 0138 `x-` hatch); see CatalogNode.ports. */
  'x-ports'?: string;
  /** ADR 0917 — feature surfaces the node reads (RFC 0138 `x-` hatch). */
  'x-requiresFeatureSurfaces'?: unknown;
  /** ADR 0937 — per-locale label/description (RFC 0138 `x-` hatch). */
  'x-localizations'?: unknown;
  role?: string;
  capabilities?: string[];
  requiredModelCapabilities?: string[];
  fallbackModel?: { provider: string; model: string };
  configSchemaRef?: string;
  inputSchemaRef?: string;
  outputSchemaRef?: string;
}

interface PackManifest {
  name: string;
  version: string;
  nodes?: PackManifestNode[];
}

/** Build the de-duplicated node catalog for this host. */
export function buildNodeCatalog(): CatalogNode[] {
  const supported = new Set(listHostSurfaces().filter((s) => s.supported).map((s) => s.name));
  const nodes: CatalogNode[] = [];

  // 1. Locally-registered modules from the in-process NodeRegistry. These have
  //    no metadata beyond typeId/version; the frontend's static catalog supplies
  //    labels/categories for them.
  const registry = getNodeRegistry();
  for (const typeId of registry.listTypeIds()) {
    const mod = registry.get(typeId);
    if (!mod) continue;
    const required = requiredHostSurfacesFor(typeId);
    nodes.push({
      typeId,
      version: mod.version,
      label: typeId,
      description: '',
      category: 'flow',
      source: 'local',
      requiresHostSurfaces: [...required],
      missingHostSurfaces: required.filter((s) => !supported.has(s)),
    });
  }

  // 2. Pack-declared nodes scanned from ./packs/*/pack.json. We surface even
  //    packs whose modules haven't loaded yet (the resolver loads them on first
  //    use) — the builder palette declares a graph using a pack node before it's
  //    resolved.
  const packDir = resolveDefaultPackDir();
  if (existsSync(packDir)) {
    for (const entry of readdirSync(packDir)) {
      // ADR 0194 P4: a tombstoned pack is hidden from every authoring surface
      // host-wide (its bytes stay for historical run resolution).
      if (isTombstoned(entry)) continue;
      if (isParkedPackDirName(entry)) continue;
      const manifestPath = join(packDir, entry, 'pack.json');
      if (!existsSync(manifestPath)) continue;
      let manifest: PackManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackManifest;
      } catch {
        continue;
      }
      if (!Array.isArray(manifest.nodes)) continue;
      for (const n of manifest.nodes) {
        // ADR 0917 — a declared feature surface is a host surface named the way
        // the seam's refusal names it (`host.sample.<id>`), missing when this
        // host does not compose that feature at all.
        const featureSurfaces = Array.isArray(n['x-requiresFeatureSurfaces'])
          ? [...new Set((n['x-requiresFeatureSurfaces'] as unknown[]).filter((x): x is string => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x)))]
          : [];
        const required = [...requiredHostSurfacesFor(n.typeId), ...featureSurfaces.map((id) => `host.sample.${id}`)];
        const composed = new Set(registeredFeatureSurfaceIds());
        const missing = [
          ...requiredHostSurfacesFor(n.typeId).filter((s) => !supported.has(s)),
          ...featureSurfaces.filter((id) => !composed.has(id)).map((id) => `host.sample.${id}`),
        ];
        nodes.push({
          typeId: n.typeId,
          // ADR 0766 — a pack row without a version must not mask the registered
          // module's (the de-dup below prefers the pack row).
          version: n.version ?? registry.get(n.typeId)?.version,
          label: n.label ?? n.typeId,
          description: n.description ?? '',
          // The palette groups on this field (frontend `mapCategory`): prefer the
          // palette hint, then the spec category.
          category: n['x-paletteCategory'] ?? n.category ?? 'flow',
          role: n.role,
          capabilities: n.capabilities,
          source: 'pack',
          packName: manifest.name,
          configSchema: readSchemaInline(packDir, entry, n.configSchemaRef),
          inputSchema: readSchemaInline(packDir, entry, n.inputSchemaRef),
          outputSchema: readSchemaInline(packDir, entry, n.outputSchemaRef),
          ...(n['x-ports'] === 'single' ? { ports: 'single' as const } : {}),
          ...((): { localizations?: CatalogNode['localizations'] } => {
            const localizations = readNodeLocalizations(n['x-localizations']);
            return localizations ? { localizations } : {};
          })(),
          requiresHostSurfaces: required,
          missingHostSurfaces: missing,
          ...(featureSurfaces.length > 0 ? { requiresFeatureSurfaces: featureSurfaces } : {}),
          ...(Array.isArray(n.requiredModelCapabilities) ? { requiredModelCapabilities: n.requiredModelCapabilities } : {}),
          ...(n.fallbackModel ? { fallbackModel: n.fallbackModel } : {}),
        });
      }
    }
  }

  // De-duplicate by typeId, preferring 'pack' source (richer metadata).
  const byTypeId = new Map<string, CatalogNode>();
  for (const n of nodes) {
    const existing = byTypeId.get(n.typeId);
    if (!existing || (existing.source === 'local' && n.source === 'pack')) {
      byTypeId.set(n.typeId, n);
    }
  }
  return Array.from(byTypeId.values());
}

/**
 * The set of node typeIds this host can actually RUN — every catalog node whose
 * required host surfaces are all advertised (no `missingHostSurfaces`). This is
 * the "closed world" a workflow may legally reference: a typeId outside it would
 * dispatch to `unknown_typeid` (absent) or fail for a missing surface at run
 * time. Reusable by any caller that wants to validate a definition against what
 * this host can run (the AI workflow-author, a builder pre-flight, a linter).
 */
/** ADR 0473 Phase 2 — the typeId→role map for review risk badges (the pack
 *  manifests' `role` taxonomy: pure / read / gate / action / side-effect /
 *  streaming-output). `buildNodeCatalog()` is sync-FS-heavy (readdir + a
 *  manifest read per pack + schema inlining), far too costly per review-list
 *  request — this trims it to roles only behind a short-lived module cache.
 *  A typeId with NO declared role is absent from the map; consumers project
 *  it as `unclassified` and any policy treats it as side-effect (fail-closed). */
const ROLE_MAP_TTL_MS = 60_000;
let roleMapCache: { at: number; map: Map<string, string> } | null = null;
let roleMapTestOverride: Map<string, string> | null = null;

/** Test seam — the pack dir (`~/.openwop-packs`) is environment-dependent in
 *  CI, so role-class behavior (ADR 0473 badges + the Phase 5 auto-approval
 *  gate) pins against an injected map. Pass null to restore the real scan. */
export function __setNodeRolesForTests(entries: Record<string, string> | null): void {
  roleMapTestOverride = entries ? new Map(Object.entries(entries)) : null;
  roleMapCache = null;
}

export function nodeRoleMap(): Map<string, string> {
  if (roleMapTestOverride) return roleMapTestOverride;
  if (roleMapCache && Date.now() - roleMapCache.at < ROLE_MAP_TTL_MS) return roleMapCache.map;
  const map = new Map<string, string>();
  // Manifest-only scan (review F6): roles live in pack.json — the full
  // `buildNodeCatalog()` additionally inlines up to 3 schema files per node,
  // all wasted work here and too heavy for a list-path cache refresh.
  const packDir = resolveDefaultPackDir();
  if (existsSync(packDir)) {
    for (const entry of readdirSync(packDir)) {
      if (isTombstoned(entry)) continue;
      if (isParkedPackDirName(entry)) continue;
      const manifestPath = join(packDir, entry, 'pack.json');
      if (!existsSync(manifestPath)) continue;
      let manifest: PackManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackManifest;
      } catch {
        continue;
      }
      if (!Array.isArray(manifest.nodes)) continue;
      for (const n of manifest.nodes) {
        if (typeof n.role === 'string' && n.role.length > 0) map.set(n.typeId, n.role);
      }
    }
  }
  roleMapCache = { at: Date.now(), map };
  return map;
}

/**
 * P2 — typeId → the config keys its `configSchema` declares REQUIRED.
 *
 * Same shape and same reasoning as `nodeRoleMap` above: a manifest + schema scan
 * is far too heavy per expansion, so it sits behind the same short-lived module
 * cache. Unlike the role map this DOES need the schema files (the `required`
 * array lives there, not in pack.json), so it reads one extra file per node type
 * that declares a `configSchemaRef`.
 *
 * A typeId absent from the map declares nothing required — consumers treat that
 * as "no constraint", which is the right default for a pack that simply hasn't
 * written a schema.
 */
const REQUIRED_CONFIG_TTL_MS = 60_000;
let requiredConfigCache: { at: number; map: Map<string, string[]> } | null = null;

export function requiredConfigKeyMap(): Map<string, string[]> {
  if (requiredConfigCache && Date.now() - requiredConfigCache.at < REQUIRED_CONFIG_TTL_MS) return requiredConfigCache.map;
  const map = new Map<string, string[]>();
  for (const n of buildNodeCatalog()) {
    const schema = n.configSchema as { required?: unknown } | undefined;
    const required = schema?.required;
    if (Array.isArray(required) && required.length > 0) {
      map.set(n.typeId, required.filter((k): k is string => typeof k === 'string'));
    }
  }
  requiredConfigCache = { at: Date.now(), map };
  return map;
}

/** The `ExpandOptions.requiredConfigKeysFor` callback, catalog-backed. */
export function requiredConfigKeysFor(typeId: string): readonly string[] {
  return requiredConfigKeyMap().get(typeId) ?? [];
}

/** ADR 0917 — the catalog as ONE tenant sees it: a node whose declared feature
 *  surface is off for the tenant gains `host.sample.<id>` in
 *  `missingHostSurfaces`, so the palette and the closed-world check stop
 *  offering what the run would refuse. */
export async function nodeCatalogForTenant(tenantId: string, catalog: readonly CatalogNode[] = buildNodeCatalog(), userId?: string): Promise<CatalogNode[]> {
  const ids = catalog.flatMap((n) => n.requiresFeatureSurfaces ?? []);
  if (ids.length === 0) return [...catalog];
  const off = await disabledFeatureSurfacesFor(tenantId, ids, userId);
  if (off.size === 0) return [...catalog];
  return catalog.map((n) => {
    const add = (n.requiresFeatureSurfaces ?? []).filter((id) => off.has(id)).map((id) => `host.sample.${id}`).filter((s) => !n.missingHostSurfaces.includes(s));
    return add.length > 0 ? { ...n, missingHostSurfaces: [...n.missingHostSurfaces, ...add] } : n;
  });
}

export function runnableNodeTypeIds(): Set<string> {
  return new Set(buildNodeCatalog().filter((n) => n.missingHostSurfaces.length === 0).map((n) => n.typeId));
}

/** Node typeIds in `def` that are NOT in `legal` (defaults to the runnable set).
 *  Empty ⇒ the definition is closed-world-valid for this host. */
export function findUnknownTypeIds(def: WorkflowDefinition, legal: Set<string> = runnableNodeTypeIds()): string[] {
  const bad = new Set<string>();
  for (const node of def.nodes) {
    if (!legal.has(node.typeId)) bad.add(node.typeId);
  }
  return [...bad];
}

/**
 * ADR 0782 — edges that name a `targetInput` on a node whose pack declares
 * `x-ports: "single"`. Such an edge routes at run time but has no handle on the
 * builder canvas, so it is INVISIBLE to the author who later opens the workflow.
 * One helper, used by BOTH authoring doors (validate + persist), as the cycle
 * check is. Returns human-readable errors; empty ⇒ fine.
 */
export function findSinglePortEdgeViolations(
  def: WorkflowDefinition,
  catalog: readonly CatalogNode[] = buildNodeCatalog(),
): string[] {
  const single = new Set(catalog.filter((n) => n.ports === 'single').map((n) => n.typeId));
  if (single.size === 0) return [];
  const typeOf = new Map(def.nodes.map((n) => [n.nodeId, n.typeId] as const));
  const out: string[] = [];
  for (const e of def.edges ?? []) {
    const t = typeOf.get(e.targetNodeId);
    if (t && single.has(t) && e.targetInput) {
      out.push(
        `Edge into '${e.targetNodeId}' (${t}) sets targetInput '${e.targetInput}', but ${t} has a single input port: `
        + 'remove targetInput and deliver the fields as output keys of one upstream node.',
      );
    }
  }
  return out;
}

function readSchemaInline(packDir: string, packEntry: string, ref: string | undefined): unknown {
  if (!ref) return undefined;
  // Refuse path-traversal attempts; only relative refs within the pack dir.
  if (ref.includes('..') || ref.startsWith('/')) return undefined;
  const schemaPath = join(packDir, packEntry, ref);
  if (!existsSync(schemaPath)) return undefined;
  try {
    const raw = readFileSync(schemaPath);
    if (raw.byteLength > MAX_SCHEMA_INLINE_BYTES) return { $ref: ref, _note: 'schema too large to inline' };
    return JSON.parse(raw.toString('utf-8'));
  } catch {
    return undefined;
  }
}


// ADR 0937 — the localized-content tag grammar's shape (`ll`, `ll-RR`, `ll-Ssss`,
// `ll-Ssss-RR`); a key outside it is dropped, never served.
const LOCALE_TAG_RE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 2000;

/** ADR 0937 — read a manifest entry's `x-localizations`, keeping only
 *  well-formed tags and non-empty, bounded `label`/`description` strings. */
export function readNodeLocalizations(raw: unknown): CatalogNode['localizations'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: NonNullable<CatalogNode['localizations']> = {};
  for (const [tag, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOCALE_TAG_RE.test(tag) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const { label, description } = v as { label?: unknown; description?: unknown };
    const entry: { label?: string; description?: string } = {};
    if (typeof label === 'string' && label.trim() && label.length <= MAX_LABEL) entry.label = label;
    if (typeof description === 'string' && description.trim() && description.length <= MAX_DESCRIPTION) entry.description = description;
    if (entry.label !== undefined || entry.description !== undefined) out[tag] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ADR 0937 — a node's palette text for the reader's most-preferred locale,
 * through the ONE normative chain every localized surface here shares
 * (`resolveLocalizedValues`: exact → script family → language → base). The
 * pack's own text is the base. The overlay map is not served, and `servedTag`
 * names the overlay used (`null` = the base), for `Content-Language`.
 */
export function localizeCatalogNode(node: CatalogNode, locale: string, baseLocale: string): { node: CatalogNode; servedTag: string | null } {
  const { localizations, ...rest } = node;
  const servedTag = matchedLocalizationTag(localizations, locale, baseLocale);
  if (!localizations || servedTag === null) return { node: rest, servedTag: null };
  const values = resolveLocalizedValues(
    { label: node.label, description: node.description },
    localizations,
    locale,
    baseLocale,
  );
  return { node: { ...rest, label: values.label, description: values.description }, servedTag };
}
