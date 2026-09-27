/**
 * RFC-grounded LLM cache-key recipe per `spec/v1/replay.md §"LLM
 * cache-key recipe"`.
 *
 * §A — Domain. The digest is computed at invocation time over a closed set of
 *      fields, and the membership test is "can it change what the model
 *      returns?" — so host metadata, request IDs, timestamps and trace headers
 *      are excluded, and `maxOutputTokens` / `stop` / `seed` are not.
 *
 * §B — Computation:
 *      1. Build the canonical object, omitting absent optionals (NOT emitting
 *         `null` placeholders) and stamping `recipe`.
 *      2. Canonicalize to bytes via RFC 8785 JCS (sorted keys, no whitespace,
 *         no trailing commas, and NO Unicode normalization).
 *      3. SHA-256 the canonical bytes.
 *      4. Encode as lowercase hex.
 *
 * ## The v1 recipe was DELETED here, not deprecated (ADR 0549 P3)
 *
 * `semanticRequestDigestV2` is the recipe — RFC 0150 §C, stamped
 * `openwop-semantic-request-v2`, pinned byte-for-byte by the eleven golden
 * vectors the conformance package ships (`test/semantic-request-digest-v2.test.ts`).
 *
 * The retired v1 pair (`projectRecipe` / `computeLLMCacheKey`) used to live
 * beside it. Its only caller was the `llm-cache-key` test seam, and that seam
 * now answers v2 — so keeping it exported would have left a retired recipe with
 * no consumer, which is how a host later computes one by accident.
 *
 * **v1 was not merely less complete — it was wrong**, and this file's own doc
 * comment used to say so approvingly: it EXCLUDED `max_tokens`, `stop`, and
 * `seed` "so cross-host determinism is preserved". All three change the
 * completion, so keying them identically does not cause a cache *miss* — it
 * causes a **wrong hit**: a response the caller never asked for, returned
 * deterministically rather than intermittently. That is why RFC 0150 classifies
 * §C as a safety-fix.
 *
 * The `spec/v1/replay.md` §E dual-read that keeps pre-P3 invocation-log records
 * resolvable does NOT use the spec's v1 recipe — this host never wrote it. It
 * recomputes the host's own pre-P3 provider key, which lives beside its single
 * call site as `legacyProviderKeyV1` in `aiProviders/aiProvidersHost.ts`.
 */

import { createHash } from 'node:crypto';

/**
 * RFC 8785 JCS canonical serialization: object keys sorted recursively by
 * UTF-16 code unit, array order preserved, no whitespace.
 *
 * **No Unicode normalization, and that is normative** (RFC 0150 §C:
 * "Implementations MUST NOT apply Unicode normalization outside JCS"). JCS does
 * not perform NFC, so a host that adds it "to be safe" produces different bytes
 * from a host that does not, for the same input, whenever a string is not
 * already normalized — silently breaking the cross-host agreement §D asserts as
 * a normative invariant. The `non-ascii-not-normalized` / `non-ascii-composed`
 * golden-vector pair exists to catch precisely that: adding NFC makes those two
 * collide while every other vector still passes.
 *
 * `Array.prototype.sort()`'s default comparator orders by UTF-16 code unit,
 * which is what JCS specifies. It is used rather than `localeCompare` on
 * purpose: locale-sensitive collation is locale-dependent, and a digest that
 * changes with the host's locale is not portable.
 *
 * `undefined` members are dropped rather than emitted, matching `JSON.stringify`
 * and the "omit absent optionals, do NOT emit null placeholders" rule of §B.1.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalize: NaN/Infinity have no JSON representation (RFC 8785)');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * RFC 0150 §C recipe stamp. It sits IN the preimage, so a v1 digest and a v2
 * digest of the same request are distinguishable rather than silently
 * comparable — which is what lets the two coexist during the §E migration
 * window without either being mistaken for the other.
 */
export const SEMANTIC_REQUEST_RECIPE_V2 = 'openwop-semantic-request-v2';

/**
 * The RFC 0150 §C v2 semantic request — `replay.md` §A's `LLMCacheKeyInput`
 * plus the four fields v1 wrongly excluded.
 *
 * The membership test for this type is one question: **can the field change what
 * the model returns?** Not whether it appears in the HTTP request. So timeout,
 * trace context, request/correlation IDs, retry counters, credential handles,
 * tenant id, run id and host metadata are all absent — and `maxOutputTokens`,
 * `stop`, `seed` and `safetySettings` are all present.
 */
export interface SemanticRequestV2Input {
  readonly provider: string;
  readonly model: string;
  readonly messages: ReadonlyArray<{
    role: string;
    content: unknown;
    name?: string;
    toolCallId?: string;
  }>;
  readonly tools?: ReadonlyArray<{ name: string; description?: string; parameters: Record<string, unknown> }>;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly responseFormat?: Record<string, unknown>;
  /** Decides whether the response is truncated. v1 excluded it. */
  readonly maxOutputTokens?: number;
  /** Decides where generation halts. v1 excluded it. */
  readonly stop?: readonly string[];
  /** Its entire purpose is to change the output. v1 excluded it. */
  readonly seed?: number;
  /** Any policy that can alter output. */
  readonly safetySettings?: Record<string, unknown>;
  /**
   * Closed, namespaced (`vendor.<provider>.<option>`) carrier for any
   * outcome-affecting provider option not named above.
   *
   * **Silently dropping an unknown option is nonconformant** (§B.1): a dropped
   * option that alters output is exactly the collision this recipe exists to
   * prevent, and dropping it is indistinguishable from the option never having
   * been set.
   */
  readonly providerOptions?: Record<string, unknown>;
}

/**
 * Project to the RFC 0150 §C v2 canonical object.
 *
 * The shape — `{recipe, provider, model, request:{…}, providerOptions?}` — is
 * fixed by the golden vectors, not chosen here; `providerOptions` sits beside
 * `request` rather than inside it.
 */
export function projectSemanticRequestV2(raw: SemanticRequestV2Input): Record<string, unknown> {
  const request: Record<string, unknown> = { messages: raw.messages };
  if (raw.tools !== undefined && raw.tools.length > 0) {
    // Tool ORDER is not semantic, so it is normalized away; message order IS,
    // so it never is. The two golden-vector pairs assert both halves.
    request.tools = [...raw.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  if (typeof raw.temperature === 'number') request.temperature = raw.temperature;
  if (typeof raw.topP === 'number') request.topP = raw.topP;
  if (typeof raw.topK === 'number') request.topK = raw.topK;
  if (typeof raw.maxOutputTokens === 'number') request.maxOutputTokens = raw.maxOutputTokens;
  if (typeof raw.seed === 'number') request.seed = raw.seed;
  if (Array.isArray(raw.stop)) request.stop = raw.stop;
  if (raw.responseFormat !== undefined && raw.responseFormat !== null) request.responseFormat = raw.responseFormat;
  if (raw.safetySettings !== undefined && raw.safetySettings !== null) request.safetySettings = raw.safetySettings;

  const out: Record<string, unknown> = {
    recipe: SEMANTIC_REQUEST_RECIPE_V2,
    provider: raw.provider,
    model: raw.model,
    request,
  };
  if (raw.providerOptions !== undefined && raw.providerOptions !== null) {
    out.providerOptions = raw.providerOptions;
  }
  return out;
}

/**
 * RFC 0150 §C — the semantic request digest v2: SHA-256 over the JCS-canonical
 * UTF-8 bytes of the v2 object, lowercase hex.
 *
 * Pinned byte-for-byte against the eleven golden vectors shipped by
 * `@openwop/openwop-conformance` (`vectors/semantic-request-digest-v2.json`) in
 * `test/semantic-request-digest-v2.test.ts`. Those vectors, not this code, are
 * the contract: §C's acceptance criterion is that TypeScript, Python and Go
 * agree, and prose cannot deliver that.
 */
export function semanticRequestDigestV2(input: SemanticRequestV2Input): string {
  return createHash('sha256')
    .update(canonicalize(projectSemanticRequestV2(input)), 'utf8')
    .digest('hex');
}
