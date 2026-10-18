/**
 * Node-type schema responder: the `kind: "node"` half of `openwop:schema.lookup`
 * (and of the Claude Code MCP `claude-code-schema-lookup`, which shares
 * `host/schemaLookup.ts`). Given node names the model asks for, it answers with
 * each node's config / input / output schemas so the model can compose a valid
 * node BEFORE authoring (CLAUDE.md "AI↔app information exchange": schema text
 * reaching a model is generated from its SSoT).
 *
 * NOTE: this is NOT the RFC 0021 `schema.request` responder — that wire kind asks
 * for an ENVELOPE KIND's schema ({ envelopeType }, answered out-of-band by
 * `agentDispatch.runChatToolLoop` from `loadEnvelopePayloadSchema`); node-type
 * schemas are a tool-mediated ask-path.
 *
 * SOURCE: `buildNodeCatalog()` — the SAME inventory `GET …/node-catalog` serves
 * (the in-process registry's modules plus every pack-declared node, with the
 * schemas inlined from each pack manifest's `configSchemaRef` / `inputSchemaRef`
 * / `outputSchemaRef`).
 *
 * > **CORRECTED 2026-10-18 (SCHRESP-PORTS-1).** This module used to read
 * > `getNodeRegistry()` and pull `inputs` / `outputs` / `configSchema` off the
 * > registered `NodeModule`. A NodeModule carries none of those (MEASURED on
 * > 991a62253: its keys are `typeId`, `version`, `execute`), so every answer was
 * > `inputs: [], outputs: []` with no `configSchema` — `core.delay` and
 * > `core.web.search` included, whose manifests declare all three — and the
 * > registry listed 62 typeIds against the catalog's 813, so a pack node not yet
 * > resolved came back `notFound`. The model was told a node had no config while
 * > the closed-world validator enforced one. The old header's "same source as
 * > node-catalog" was the false claim; this is now literally true.
 */

import { createHash } from 'node:crypto';
import { buildNodeCatalog, type CatalogNode } from './nodeCatalogBuilder.js';

export interface SchemaRequestPayload {
  /** Node-type names the model is asking for. */
  names: string[];
  /** Optional free-form context. */
  context?: string;
}

export interface NodeTypeSchemaSummary {
  typeId: string;
  /** Canonical kind name — the typeId's trailing segment (e.g. "mock-ai"). */
  kind: string;
  /** Input field descriptors, one per property of the node's input schema
   *  (`{ name, type }`; `type` is the JSON-schema type, `any` when untyped).
   *  Empty when the node declares no input schema or no properties. */
  inputs: Array<{ name: string; type: string }>;
  /** Output field descriptors, from the node's output schema. */
  outputs: Array<{ name: string; type: string }>;
  /** The node's config schema, verbatim from its manifest. Omitted when the
   *  node declares none. */
  configSchema?: Record<string, unknown>;
  /** The node's input / output JSON schemas, verbatim. Omitted when absent. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** ADR 0782 — `single`: the node has ONE input port; deliver fields as
   *  output keys of one upstream node, never via an edge `targetInput`. */
  ports?: 'single';
  /** Host surfaces this node needs that THIS host does not advertise. Present
   *  only when non-empty: such a node is not runnable here (the closed-world
   *  validator, `runnableNodeTypeIds`, refuses it). */
  missingHostSurfaces?: string[];
}

export interface SchemaResponsePayload {
  /** Schemas the host could resolve. */
  schemas: NodeTypeSchemaSummary[];
  /** Names the host could NOT resolve ("not available on this host"). */
  notFound: string[];
  /** Hash of the sorted catalog typeIds — distinct per node inventory, so a
   *  caller can cache answers across turns. */
  bundleVersion: string;
}

/** Build the answer for the given names. Exact typeId first, then
 *  trailing-segment, then case/separator-insensitive segment match, to absorb
 *  common model drift (e.g. "MockAi" for "mock-ai"). */
export function buildSchemaResponse(req: SchemaRequestPayload, catalog: readonly CatalogNode[] = buildNodeCatalog()): SchemaResponsePayload {
  const byTypeId = new Map(catalog.map((n) => [n.typeId, n] as const));
  const allTypeIds = [...byTypeId.keys()];
  const allKinds = new Set<string>(allTypeIds.map(tailSegment));

  const schemas: NodeTypeSchemaSummary[] = [];
  const notFound: string[] = [];

  for (const requestedName of req.names) {
    if (typeof requestedName !== 'string' || requestedName.length === 0) {
      continue;
    }
    const resolved = resolveTypeId(requestedName, allTypeIds, allKinds);
    const node = resolved ? byTypeId.get(resolved) : undefined;
    if (!resolved || !node) {
      notFound.push(requestedName);
      continue;
    }
    const configSchema = asSchema(node.configSchema);
    const inputSchema = asSchema(node.inputSchema);
    const outputSchema = asSchema(node.outputSchema);
    schemas.push({
      typeId: resolved,
      kind: tailSegment(resolved),
      inputs: fieldsOf(inputSchema),
      outputs: fieldsOf(outputSchema),
      ...(configSchema ? { configSchema } : {}),
      ...(inputSchema ? { inputSchema } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      ...(node.ports === 'single' ? { ports: 'single' as const } : {}),
      ...(node.missingHostSurfaces.length > 0 ? { missingHostSurfaces: [...node.missingHostSurfaces] } : {}),
    });
  }

  return {
    schemas,
    notFound,
    bundleVersion: hashTypeIds(allTypeIds),
  };
}

function hashTypeIds(typeIds: readonly string[]): string {
  const joined = [...typeIds].sort().join('\n');
  return `registry-${createHash('sha256').update(joined).digest('hex').slice(0, 12)}`;
}

/** Resolve a user-supplied name to a canonical typeId. Tries exact
 *  match first, then trailing-segment match (e.g., "mock-ai" matches
 *  "local.sample.demo.mock-ai"), then case-insensitive. */
function resolveTypeId(
  name: string,
  allTypeIds: readonly string[],
  allKinds: ReadonlySet<string>,
): string | null {
  if (allTypeIds.includes(name)) return name;
  // Trailing-segment match: "mock-ai" → "local.sample.demo.mock-ai"
  if (allKinds.has(name)) {
    const match = allTypeIds.find((id) => tailSegment(id) === name);
    if (match) return match;
  }
  // Case-insensitive trailing-segment match (absorbs "MockAi", "mock_ai", etc.)
  const lower = name.toLowerCase().replace(/[-_]/g, '');
  const ciMatch = allTypeIds.find((id) => tailSegment(id).toLowerCase().replace(/[-_]/g, '') === lower);
  return ciMatch ?? null;
}

function tailSegment(typeId: string): string {
  const idx = typeId.lastIndexOf('.');
  return idx >= 0 ? typeId.slice(idx + 1) : typeId;
}

/** A manifest schema object, or null. `readSchemaInline` returns a
 *  `{ $ref, _note }` stub for an over-size schema — still an object, served as is
 *  so the model sees where the schema lives rather than nothing. */
function asSchema(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

/** One `{ name, type }` per property of an object schema. */
function fieldsOf(schema: Record<string, unknown> | null): Array<{ name: string; type: string }> {
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.entries(props as Record<string, unknown>).map(([name, p]) => {
    const t = p && typeof p === 'object' ? (p as { type?: unknown }).type : undefined;
    return { name, type: typeof t === 'string' ? t : Array.isArray(t) ? t.filter((x) => typeof x === 'string').join('|') || 'any' : 'any' };
  });
}
