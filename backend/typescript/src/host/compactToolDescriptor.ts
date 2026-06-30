/**
 * RFC 0112 — Compact tool projection.
 *
 * The canonical *wire* compact shape for `GET /v1/tools?view=compact` and
 * `GET /v1/tools/{toolId}?view=compact`. The shape is the steward-owned spec
 * schema `compact-tool-descriptor.schema.json`: required `toolId`+`source`+
 * `safetyTier`; optional `title`/`description`/`inputSchema`; everything else
 * (`auth`/`egress`/`approval`/`replayPolicy`/`outputSchema`/`costHint`/
 * `latencyHint`) DROPPED. `additionalProperties:false`.
 *
 * Relationship to ADR 0148 A3 (`providers/toolSchemaCompaction.ts`): A3 is a
 * SIBLING, not the same shape. A3 strips non-validating annotation keys from the
 * inputSchema but PRESERVES `$ref`/`oneOf`/`allOf` (functional-preserving, so the
 * model can still construct valid calls) and is WIRE-INVISIBLE (host→provider
 * request only). This projection is stricter and wire-facing: it reduces the
 * inputSchema to a self-contained structural SUBSET (NO `$ref`/`oneOf`/`allOf`/
 * `anyOf`/`not`/`patternProperties`/`dependentSchemas`) and is a lossy VIEW — the
 * full inputSchema remains the validation authority on tool dispatch. The two
 * share the annotation-strip primitive (below), not the output shape.
 */

/** Non-validating JSON-Schema annotation keys — token cost, no effect on what a
 *  valid call looks like. Mirrors ADR 0148 A3's denylist (the one shared
 *  primitive). Stripped at every depth before the subset check. */
const ANNOTATION_KEYS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'markdownDescription',
]);

/** Composition keywords forbidden by the compact structural subset. Their
 *  presence ANYWHERE in the schema means it is NOT self-contained, so the
 *  compact descriptor omits `inputSchema` rather than emit a lossy/invalid one. */
const NON_SUBSET_KEYS = new Set([
  '$ref',
  '$defs',
  'definitions',
  'oneOf',
  'allOf',
  'anyOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
]);

/** The compact descriptor — exactly `compact-tool-descriptor.schema.json`. */
export interface CompactToolDescriptor {
  toolId: string;
  source: string;
  safetyTier: 'read' | 'write';
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A full descriptor as produced by the standard `GET /v1/tools` projection. */
export interface FullToolDescriptor {
  toolId: string;
  source: string;
  safetyTier: 'read' | 'write';
  title?: string;
  description?: string;
  inputSchema?: unknown;
  [k: string]: unknown;
}

/** Deep-clone with annotation keys stripped at every depth. Non-mutating. */
function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ANNOTATION_KEYS.has(k)) continue;
      out[k] = stripAnnotations(v);
    }
    return out;
  }
  return value;
}

/** True if any composition keyword forbidden by the subset appears at any depth. */
function hasNonSubsetKeyword(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNonSubsetKeyword);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (NON_SUBSET_KEYS.has(k)) return true;
      if (hasNonSubsetKeyword(v)) return true;
    }
  }
  return false;
}

/**
 * Reduce an `inputSchema` to the compact structural subset, or return
 * `undefined` when it cannot be represented losslessly (it is OPTIONAL — an
 * honest omission beats a fabricated/lossy schema). The subset requires a
 * top-level `type:"object"` with `properties` and no forbidden composition
 * keyword at any depth (after annotation-stripping).
 */
export function compactInputSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const stripped = stripAnnotations(schema) as Record<string, unknown>;
  if (stripped.type !== 'object') return undefined;
  if (typeof stripped.properties !== 'object' || stripped.properties === null) return undefined;
  if (hasNonSubsetKeyword(stripped)) return undefined;
  return stripped;
}

/**
 * Project a full tool descriptor to the compact wire shape. Drops every field
 * outside the compact schema; includes `inputSchema` only when it satisfies the
 * subset. The `toolId`/`source`/`safetyTier`/`title`/`description` carry through
 * verbatim, so the compact `toolId` set equals the standard view's for the same
 * principal (the caller passes the SAME authorization-scoped list).
 */
export function toCompactDescriptor(full: FullToolDescriptor): CompactToolDescriptor {
  const out: CompactToolDescriptor = {
    toolId: full.toolId,
    source: full.source,
    safetyTier: full.safetyTier,
  };
  if (typeof full.title === 'string') out.title = full.title;
  if (typeof full.description === 'string') out.description = full.description;
  const compactSchema = compactInputSchema(full.inputSchema);
  if (compactSchema) out.inputSchema = compactSchema;
  return out;
}
