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
 *  - NON-MUTATING. Deep-clone; never mutate the caller's tool objects. The
 *    replay cache-key recipe (`llmCacheKey.ts`, exercised via the RFC 0041 test
 *    seam) projects the LOGICAL tool schema; compaction is a dispatcher-local
 *    transform on a copy, so the key is identical whether the diet is on or off
 *    (toggle-independent replay).
 *  - FUNCTIONAL-PRESERVING. Only the annotation denylist below is removed.
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

/** Non-validating JSON-Schema annotation keys that cost tokens but never affect
 *  what a valid tool call looks like. Stripped at every depth of the schema. */
const STRIP_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  'title',
  'examples',
  '$comment',
  'markdownDescription',
  'deprecated',
]);

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = compactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Return a NEW tool `inputSchema` with non-functional annotation keys stripped
 * at every depth. Non-mutating: the input object is never touched. When the diet
 * is off (or the schema isn't an object), the input is returned unchanged so the
 * request body is byte-identical to today.
 */
export function compactToolSchema<T extends Record<string, unknown>>(schema: T, enabled: boolean): T {
  if (!enabled || !schema || typeof schema !== 'object') return schema;
  return compactValue(schema) as T;
}
