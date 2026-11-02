/**
 * ADR 0148 Phase 2 (lever A3) — tool-surface diet via schema compaction.
 *
 * A tool's JSON-Schema `inputSchema` is re-sent to the model every turn. Much of
 * it is non-validating ANNOTATION metadata (`$schema`, `$id`, `title`,
 * `examples`, `$comment`, `markdownDescription`, `deprecated`) that costs tokens
 * but does not change what a valid tool call looks like — providers and models
 * ignore it when constructing a call. Stripping it shrinks the model-facing tool
 * catalog without degrading tool-call correctness.
 *
 * INVARIANTS (architect review, ADR 0148 Phase 2):
 *  - NON-MUTATING. Builds new schema objects; value positions (`enum`, `default`,
 *    …) are shared by reference and never written. Never mutates the caller. The
 *    replay cache-key recipe (`llmCacheKey.ts`, exercised via the RFC 0041 test
 *    seam) projects the LOGICAL tool schema; compaction is a dispatcher-local
 *    transform on a copy, so the key is identical whether the diet is on or off
 *    (toggle-independent replay).
 *  - FUNCTIONAL-PRESERVING. Only the annotation denylist below is removed, and
 *    only in KEYWORD position (ADR 1003 D1): a property NAMED `title` is kept.
 *    Everything that defines a valid call — `type`, `properties`, `required`,
 *    `description`, `enum`, `const`, `items`, `anyOf`/`oneOf`/`allOf`, `$ref`,
 *    `$defs`/`definitions`, `format`, `pattern`, `min*`/`max*`,
 *    `additionalProperties` — is kept, so `$ref`/`$defs` still resolve and the
 *    model still sees type + required + description + enum guidance.
 *  - DESCRIPTIONS ARE KEPT. They are functional guidance to the model; trimming
 *    them risks tool-call quality and is deliberately out of scope here.
 *  - WIRE-INVISIBLE. The compacted schema only affects the host→provider request
 *    body; the OpenWOP tool catalog (`GET /v1/tools`) is built from the originals.
 */
import { contextEconomy, logContextEconomyApplied } from '../host/contextEconomy.js';

/** Non-validating JSON-Schema annotation keywords that cost tokens but never
 *  affect what a valid tool call looks like. Stripped only where they are
 *  KEYWORDS of a schema object — never where they are the NAME of a property. */
const STRIP_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  'title',
  'examples',
  '$comment',
  'markdownDescription',
  'deprecated',
]);

/** Keywords whose value is ONE subschema, or an array of subschemas (`items`
 *  is either, by draft). */
const SUBSCHEMA_KEYS: ReadonlySet<string> = new Set([
  'items', 'prefixItems', 'additionalItems', 'contains', 'not', 'if', 'then', 'else',
  'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames',
  'allOf', 'anyOf', 'oneOf',
]);

/** Keywords whose value is a NAME → subschema map. The keys are names the
 *  model must see (a property called `title` is a parameter, not an
 *  annotation); only the values are schemas. */
const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
]);

/**
 * ADR 1003 D1 — the walk knows which position it is in. The first version
 * treated every object key as a keyword and stripped `title`/`examples`/
 * `deprecated`/`$id` at every depth, so it deleted real PARAMETERS with those
 * names from `properties` while `required` still listed them (the default-on
 * `openwop:kanban.add-todo` lost `title`). Every keyword not listed above
 * (`enum`, `const`, `default`, `required`, vendor keys, …) is a VALUE and is
 * copied verbatim, never recursed into, so an `enum` of objects keeps its keys.
 */
function compactSchema(schema: unknown): unknown {
  // Boolean schemas (`true`/`false`) and malformed values pass through.
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (STRIP_KEYS.has(k)) continue;
    if (SUBSCHEMA_KEYS.has(k)) out[k] = Array.isArray(v) ? v.map(compactSchema) : compactSchema(v);
    else if (SCHEMA_MAP_KEYS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      const map: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) map[name] = compactSchema(sub);
      out[k] = map;
    } else out[k] = v;
  }
  return out;
}

/**
 * Return a NEW tool `inputSchema` with non-functional annotation keys stripped
 * at every depth. Non-mutating: the input object is never touched. When the diet
 * is off (or the schema isn't an object), the input is returned unchanged so the
 * request body is byte-identical to today.
 */
export function compactToolSchema<T extends Record<string, unknown>>(schema: T, enabled: boolean): T {
  if (!enabled || !schema || typeof schema !== 'object') return schema;
  return compactSchema(schema) as T;
}

/** A tool as the dispatchers hand it to a provider. */
interface DietableTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * ADR 1003 D4 — the ONE entry the model-facing funnels use: compact every
 * tool's `inputSchema` when the A3 lever is on, and report what it did (ADR
 * 0148 guardrail 3 — a lever that cannot be seen working cannot be measured
 * before it is flipped on). Off ⇒ the same tool objects, no log, no cost.
 */
export function dietToolSurface<T extends DietableTool>(tools: readonly T[], tenantId: string | undefined): T[] {
  if (!contextEconomy().toolDiet || tools.length === 0) return [...tools];
  let bytesSaved = 0;
  const out = tools.map((t) => {
    const inputSchema = compactToolSchema(t.inputSchema, true);
    bytesSaved += JSON.stringify(t.inputSchema ?? null).length - JSON.stringify(inputSchema ?? null).length;
    return { ...t, inputSchema };
  });
  logContextEconomyApplied('tool_diet', tenantId, { toolSchemasCompacted: out.length, toolSchemaBytesSaved: bytesSaved });
  return out;
}
