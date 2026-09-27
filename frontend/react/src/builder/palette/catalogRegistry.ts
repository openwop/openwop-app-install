/**
 * Runtime-augmentable catalog of NodeCatalogEntry rows.
 *
 * On boot, `loadDynamicCatalog()` fetches GET /host/openwop-app/node-catalog
 * and merges every pack-declared node into the registry. Subscribers
 * (palette / canvas nodes / inspector) re-render via `useCatalog()`.
 *
 * ADR 0440 P3 — the BACKEND is the authority on what node types exist; this
 * module's static `NODE_CATALOG` is a PRESENTATION OVERLAY (labels, badges,
 * accents, curated config fields). `loadDynamicCatalog()` ingests every server
 * row and composes it with the static entry when one exists (`mergeWithStatic`),
 * so lookups return dynamic before static — as documented, and now as coded.
 *
 * Resolution and visibility are separate: `catalogEntry` / `catalogEntryByTypeId`
 * resolve EVERYTHING (so any workflow opens), while `mergedCatalog()` — the
 * palette — omits the acknowledged non-authorable types (`PALETTE_EXCLUDED`).
 */

import { useSyncExternalStore } from 'react';
import { NODE_CATALOG, type NodeCatalogEntry } from './nodeCatalog.js';
import { configFieldsFromSchema } from './configFieldsFromSchema.js';
import type { NodeCategory } from '../schema/workflow.js';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

// Re-exported for backward compat — `configFieldsFromSchema` used to live
// in this file but moved to its own module for unit testability.
export { configFieldsFromSchema };

interface ServerCatalogNode {
  typeId: string;
  version: string;
  label: string;
  description: string;
  category: string;
  role?: string;
  capabilities?: readonly string[];
  source: 'local' | 'pack';
  packName?: string;
  configSchema?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Host surfaces this node needs (e.g. `host.kvStorage`). */
  requiresHostSurfaces?: readonly string[];
  /** Subset of requiresHostSurfaces this host does NOT advertise. */
  missingHostSurfaces?: readonly string[];
}

const dynamicByKind = new Map<string, NodeCatalogEntry>();
let lastLoadedAt = 0;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function getSnapshot(): number {
  return lastLoadedAt;
}

const STATIC_BY_KIND = new Map(NODE_CATALOG.map((e) => [e.kind, e]));
const STATIC_BY_TYPEID = new Map(NODE_CATALOG.map((e) => [e.typeId, e]));

export function catalogEntry(kind: string): NodeCatalogEntry | undefined {
  // ADR 0440 P3 — dynamic FIRST, matching this module's documented contract
  // (it said "dynamic before static" while the code did the opposite). Safe
  // because a dynamic row for a typeId with a static entry is now the MERGE of
  // both (`mergeWithStatic`) — it already carries the static presentation, plus
  // the server's host-surface facts the old skip discarded. Static remains the
  // fallback for entries the server does not know (client-only sticky notes).
  return dynamicByKind.get(kind) ?? STATIC_BY_KIND.get(kind);
}

/** Reverse lookup by canonical typeId (inverse of `kind`). Dynamic pack
 *  entries are keyed by typeId already, so this resolves both static and
 *  pack nodes. Used to import a canonical WorkflowDefinition (which
 *  references nodes by typeId) back into the builder. */
export function catalogEntryByTypeId(typeId: string): NodeCatalogEntry | undefined {
  return dynamicByKind.get(typeId) ?? STATIC_BY_TYPEID.get(typeId);
}

export function defaultConfigFor(kind: string): Record<string, unknown> {
  const entry = catalogEntry(kind);
  if (!entry) return {};
  const cfg: Record<string, unknown> = {};
  for (const f of entry.configFields) {
    if (f.defaultValue !== undefined) cfg[f.key] = f.defaultValue;
  }
  return cfg;
}

/**
 * The AUTHORABLE catalog — what the palette offers and the canvas renders.
 *
 * ADR 0440 P3 draws the line the old single map blurred: **resolution** and
 * **visibility** are different questions. `catalogEntry` / `catalogEntryByTypeId`
 * must resolve EVERY registered type (otherwise a workflow containing one can't
 * be opened — the bug this ADR fixes). The palette must offer only what an
 * author can meaningfully drag onto a canvas.
 *
 * Without that split, ingesting all rows would drop conformance harness
 * fixtures, ADR 0376 replay-only aliases, and app-builder MCP internals into the
 * palette — ~17 entries of non-authorable noise, all categorised `flow`.
 */
export function mergedCatalog(): NodeCatalogEntry[] {
  const seen = new Set<string>();
  const out: NodeCatalogEntry[] = [];
  for (const entry of NODE_CATALOG) {
    if (isPaletteExcluded(entry.typeId)) continue;
    seen.add(entry.kind);
    out.push(entry);
  }
  for (const entry of dynamicByKind.values()) {
    if (seen.has(entry.kind)) continue;
    if (isPaletteExcluded(entry.typeId)) continue;
    seen.add(entry.kind);
    out.push(entry);
  }
  return out;
}

/** Every type that RESOLVES, palette-visible or not — the parity test's subject
 *  (visibility is `mergedCatalog`; this is resolvability). */
export function resolvableTypeIds(): string[] {
  // Read typeIds off the ENTRIES, never the map keys: since the P3-1 fix the
  // map is dual-indexed (by typeId and by the friendly kind), so its keys are
  // a mix of both and would report 'noop' as if it were a typeId.
  return [...new Set([
    ...NODE_CATALOG.map((e) => e.typeId),
    ...[...dynamicByKind.values()].map((e) => e.typeId),
  ])].sort();
}

export function useCatalog(): NodeCatalogEntry[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return mergedCatalog();
}

let loadPromise: Promise<void> | null = null;

export function loadDynamicCatalog(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const res = await fetch(`${config.baseUrl}/host/openwop-app/node-catalog`, fetchOpts({
        headers: authedHeaders(),
      }));
      if (!res.ok) return;
      const body = (await res.json()) as { nodes: ServerCatalogNode[] };
      for (const node of body.nodes) {
        // ADR 0440 P3 — ingest EVERY row, not just `source: 'pack'`.
        //
        // Host-registered nodes report `source: 'local'`, so skipping them meant
        // they resolved ONLY from the hand-maintained static catalog — and 37 of
        // them were absent from it, making every workflow that used one
        // un-openable (`errCantLoadNodeTypes`). That included
        // `local.sample.demo.mock-ai`, which the workflow-author seeder builds
        // its showcase workflows from, contradicting that seeder's own promise
        // of "something runnable to open in the builder".
        //
        // The backend is the authority on what EXISTS; the static catalog is
        // now a presentation overlay (see `mergeWithStatic`).
        const merged = mergeWithStatic(node);
        dynamicByKind.set(node.typeId, merged);
        // Grade-pass: `mergeWithStatic` keeps the static entry's FRIENDLY kind
        // ('noop', 'delay'), but this map was only keyed by typeId — so
        // `catalogEntry('noop')` missed it and fell through to the RAW static
        // row, discarding the server's `missingHostSurfaces`. The merge was
        // computed and thrown away for exactly the nodes it was written for.
        // Index under both keys so every lookup reaches it.
        if (merged.kind !== node.typeId) dynamicByKind.set(merged.kind, merged);
      }
      lastLoadedAt = Date.now();
      notify();
    } catch {
      /* registry unreachable; static catalog still works */
    } finally {
      // Don't null loadPromise — subsequent calls in the same session
      // reuse the resolved promise (catalog refreshes are explicit).
    }
  })();
  return loadPromise;
}

/**
 * Node types that RESOLVE (so any workflow containing them opens) but are NOT
 * offered in the palette, each with the reason it isn't authorable (ADR 0440
 * P3). Modelled on `host/seedCoverage.ts` ACKNOWLEDGED_UNSEEDED: an exclusion
 * is a recorded decision, not an oversight.
 *
 * This list is load-bearing in two places — it gates palette visibility here,
 * and the parity test treats it as the ONLY acceptable reason for a registered
 * node type to be absent from the palette. Adding a row is therefore a
 * deliberate act, which is the point.
 */
export const PALETTE_EXCLUDED: Readonly<Record<string, string>> = {
  'ui.tour.step': 'ADR 0376 legacy alias of ui.walkthrough.step — registered only so pre-rename runs replay',
  'ui.tour.checkpoint': 'ADR 0376 legacy alias of ui.walkthrough.checkpoint — replay only',
  'conformance.cost.emit': 'conformance harness fixture, not an authorable node',
  'conformance.modelCapability.insufficient': 'conformance harness fixture',
  'conformance.requiresMissing': 'conformance harness fixture',
  'conformance.secret.echo': 'conformance harness fixture',
  'core.conformance.mock-agent': 'conformance harness fixture',
};

/** A prefix whose nodes are internal machinery, driven by the app-builder
 *  feature itself rather than dragged onto a canvas by an author. */
const PALETTE_EXCLUDED_PREFIXES = ['app-builder.mcp-node.'] as const;

function isPaletteExcluded(typeId: string): boolean {
  return typeId in PALETTE_EXCLUDED || PALETTE_EXCLUDED_PREFIXES.some((p) => typeId.startsWith(p));
}

// ADR 0440 P3 (grade-pass) — labelling machine-derived node typeIds for a
// palette an author SCANS and DRAGS. Three failure modes to avoid: two nodes
// reading identically ("Query" for both bigquery and workday), mangled
// acronyms ("Hris action"), and mixed casing. Design rule (frontend-design
// skill: "name things by what people recognize"): for these nodes the external
// SYSTEM is what the author recognizes, so surface it when the action word
// alone is ambiguous, and render in sentence case to match the authored static
// labels ("HTTP fetch", "Emit image", "Pass-through").

/** Leading namespace segments that carry no meaning for a human label. */
const LABEL_NOISE_SEGMENTS = new Set(['core', 'local', 'vendor', 'openwop', 'openwop-app', 'connectors', 'sample', 'demo', 'app-builder', 'ui']);

/** Generic action words whose LAST segment does not identify the node — the
 *  domain segment before it must be surfaced to disambiguate (bigquery.query
 *  vs workday.query). */
const GENERIC_ACTION_WORDS = new Set(['query', 'send', 'draft', 'create', 'update', 'delete', 'action', 'fetch', 'run', 'list', 'get', 'transition', 'write', 'search', 'emit', 'sync', 'clarify']);

/** Initialisms rendered uppercase rather than title-cased. */
const LABEL_ACRONYMS = new Set(['ai', 'api', 'hris', 'erp', 'crm', 'cms', 'http', 'https', 'mcp', 'a2ui', 'ucp', 'sql', 'url', 'id', 'kv', 'llm', 'cad', 'sso', 'json', 'csv', 'pdf', 'ics']);

/** Named external systems with non-obvious internal casing. */
const LABEL_BRANDS: Record<string, string> = { bigquery: 'BigQuery', workday: 'Workday', hubspot: 'HubSpot', openai: 'OpenAI', heygen: 'HeyGen', runway: 'Runway' };

/** One palette word → its display form (acronym / brand / sentence-case). */
function displayWord(word: string, isFirst: boolean): string {
  const lower = word.toLowerCase();
  if (LABEL_BRANDS[lower]) return LABEL_BRANDS[lower];
  if (LABEL_ACRONYMS.has(lower)) return lower.toUpperCase();
  // Sentence case: the first word leads with a capital; the rest stay lower.
  return isFirst ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : lower;
}

/**
 * Presentation fallback for a host-registered row, whose server label IS its
 * typeId (`nodeCatalogBuilder` has no metadata for locals by design). Renders
 * e.g. `core.bigquery.query` → "BigQuery query", `core.workday.query` →
 * "Workday query", `local.sample.demo.mock-ai` → "Mock AI",
 * `core.subWorkflow` → "Sub workflow" — legible, unambiguous, without pushing
 * presentation into the backend.
 */
function prettifyTypeId(typeId: string): string {
  const meaningful = typeId.split('.').filter((seg) => !LABEL_NOISE_SEGMENTS.has(seg));
  const segs = meaningful.length > 0 ? meaningful : [typeId.split('.').pop() ?? typeId];
  const last = segs[segs.length - 1]!;
  // Surface the domain segment when the action word alone doesn't identify the node.
  const chosen = GENERIC_ACTION_WORDS.has(last.toLowerCase()) && segs.length > 1
    ? [segs[segs.length - 2]!, last]
    : [last];
  // Split each chosen segment into words (dash/underscore + camelCase boundaries).
  const words = chosen.flatMap((seg) => seg.replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')).filter(Boolean);
  return words.map((w, i) => displayWord(w, i === 0)).join(' ');
}

/**
 * Compose a server row with its static entry, if one exists (ADR 0440 P3).
 *
 * Existence and host-surface facts come from the SERVER (it is the authority on
 * what is registered and which surfaces this host advertises). Presentation and
 * curated config fields come from the STATIC catalog where present.
 *
 * This replaces a `continue` that skipped any row with a static entry — which
 * silently discarded the server's `missingHostSurfaces` for every static node,
 * so the builder could not warn that this host lacks a surface a node needs.
 * One typeId (`core.delay`) is declared BOTH statically and by a pack, and was
 * losing its pack metadata to that skip.
 */
function mergeWithStatic(node: ServerCatalogNode): NodeCatalogEntry {
  const dynamic = toCatalogEntry(node);
  const staticEntry = STATIC_BY_TYPEID.get(node.typeId);
  if (!staticEntry) return dynamic;
  return {
    ...dynamic,
    kind: staticEntry.kind,            // keep the friendly slug ('noop', 'delay')
    label: staticEntry.label,
    description: staticEntry.description,
    category: staticEntry.category,
    badge: staticEntry.badge,
    accent: staticEntry.accent,
    inputs: staticEntry.inputs,
    outputs: staticEntry.outputs,
    // Curated fields beat schema-derived ones; fall back to the server's.
    configFields: staticEntry.configFields.length > 0 ? staticEntry.configFields : dynamic.configFields,
    ...(staticEntry.clientOnly ? { clientOnly: true } : {}),
  };
}

function toCatalogEntry(node: ServerCatalogNode): NodeCatalogEntry {
  const category = mapCategory(node.category);
  const accent = accentFor(category);
  // A host-registered row carries `label === typeId` (the backend has no
  // metadata for locals); prettify it so the palette doesn't read like a
  // stack trace. Pack rows carry a real authored label — leave those alone.
  const label = node.label === node.typeId ? prettifyTypeId(node.typeId) : node.label;
  const badge = badgeFor(label, node.typeId);
  return {
    kind: node.typeId,
    typeId: node.typeId,
    label,
    description: node.description,
    category,
    badge,
    accent,
    inputs: portsFromSchema(node.inputSchema, 'in'),
    outputs: portsFromSchema(node.outputSchema, 'out'),
    configFields: configFieldsFromSchema(node.configSchema),
    ...(node.packName ? { packName: node.packName } : {}),
    ...(node.requiresHostSurfaces && node.requiresHostSurfaces.length > 0
      ? { requiresHostSurfaces: node.requiresHostSurfaces }
      : {}),
    ...(node.missingHostSurfaces && node.missingHostSurfaces.length > 0
      ? { missingHostSurfaces: node.missingHostSurfaces }
      : {}),
  };
}

/**
 * Derive port definitions from a JSON Schema. Top-level required
 * properties become individual ports so the canvas shows what data
 * each node expects/emits. If the schema has no `properties` or no
 * required fields, fall back to a single `<fallbackName>` port of
 * type `object` so the node still connects.
 *
 * Port types are mapped from JSON Schema types — string/number/
 * boolean stay, object/array collapse to 'object' (we don't model
 * 'array' in our PortType union).
 */
function portsFromSchema(schema: unknown, fallbackName: string): { name: string; type: import('../schema/workflow.js').PortType }[] {
  if (!schema || typeof schema !== 'object') {
    return [{ name: fallbackName, type: 'object' }];
  }
  const s = schema as Record<string, unknown>;
  const props = s.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  if (!props || required.length === 0) {
    return [{ name: fallbackName, type: 'object' }];
  }
  const ports: { name: string; type: import('../schema/workflow.js').PortType }[] = [];
  for (const propName of required) {
    const prop = props[propName];
    if (!prop || typeof prop !== 'object') continue;
    const ps = prop as Record<string, unknown>;
    const t = Array.isArray(ps.type) ? (ps.type[0] as string) : (ps.type as string | undefined);
    let portType: import('../schema/workflow.js').PortType = 'any';
    if (t === 'string') portType = 'string';
    else if (t === 'number' || t === 'integer') portType = 'number';
    else if (t === 'boolean') portType = 'boolean';
    else if (t === 'object' || t === 'array') portType = 'object';
    ports.push({ name: propName, type: portType });
  }
  return ports.length > 0 ? ports : [{ name: fallbackName, type: 'object' }];
}

function mapCategory(raw: string): NodeCategory {
  switch (raw) {
    case 'data':
    case 'ai':
    case 'flow':
    case 'control':
    case 'integration':
      return raw;
    default:
      return 'control';
  }
}

function accentFor(category: NodeCategory): string {
  switch (category) {
    case 'flow': return 'var(--cat-flow)';
    case 'data': return 'var(--cat-data)';
    case 'ai': return 'var(--cat-ai)';
    case 'control': return 'var(--cat-control)';
    case 'integration': return 'var(--cat-integration)';
  }
}

function badgeFor(label: string, typeId: string): string {
  const source = label || typeId;
  // Grab the first letter that isn't whitespace.
  const letter = source.replace(/[^a-zA-Z0-9]/g, '').charAt(0);
  return letter ? letter.toUpperCase() : '?';
}

