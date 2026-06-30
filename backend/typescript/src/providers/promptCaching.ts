/**
 * ADR 0148 Phase 1 (lever A2) — Anthropic prompt-caching helpers.
 *
 * Anthropic caches a request's stable PREFIX (tools, then system) when a
 * `cache_control: { type: 'ephemeral' }` breakpoint is placed on the last block
 * of that prefix; the volatile `messages[]` after it stay uncached. Marking the
 * system block + the last tool definition turns the per-turn re-send of the
 * (large, stable) system prompt and tool surface into a ~90%-cheaper cache READ
 * instead of a full re-bill — without summarizing anything, so it carries no
 * answer-quality risk (ADR 0148: ship A2 first).
 *
 * INVARIANTS (architect review, ADR 0148 Phase 1):
 *  - NON-MUTATING. These helpers build NEW objects; they never mutate the
 *    caller's `messages`/`tools` arrays. The replay cache key
 *    (`llmCacheKey.ts:projectRecipe`) is computed over the LOGICAL recipe
 *    (messages, tools{name,description,parameters}), not the HTTP body — so
 *    cache_control is invisible to it ONLY as long as we don't mutate those
 *    inputs and never place cache_control INSIDE a tool's `input_schema`.
 *  - WIRE-INVISIBLE. cache_control is an Anthropic request-body detail; it never
 *    reaches an OpenWOP run event or capability. The only run-event touch is the
 *    existing `providerUsage.cacheHit` boolean (set elsewhere).
 *  - Below Anthropic's minimum cacheable prefix (~1024 tok) the API silently
 *    skips caching — no error, just no benefit. So we always mark; never gate on
 *    a length estimate of our own.
 */

const EPHEMERAL = { type: 'ephemeral' as const };

/** A text block of an Anthropic `system` array, optionally cache-marked. */
export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: typeof EPHEMERAL;
}

/** A tool definition as sent to the Anthropic Messages API (post-sanitization),
 *  optionally cache-marked on the final element. `cache_control` is a SIBLING of
 *  `input_schema`, never inside it (replay-key safety). `input_schema` is
 *  optional because Anthropic SERVER tools (e.g. `web_search`) carry a `type`
 *  instead — so the assembled tools array is heterogeneous without a cast. */
export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  cache_control?: typeof EPHEMERAL;
  /** Server tools (e.g. web_search) carry a `type` instead of an input_schema. */
  type?: string;
  [k: string]: unknown;
}

/** A (tenant, cachePrefixId) scope for the cached prefix (RFC 0116). */
export interface CachePrefixScope {
  tenant: string;
  cachePrefixId: string;
}

/**
 * RFC 0116 — the deterministic, NON-SECRET marker that namespaces the cached
 * prefix by `(tenant, cachePrefixId)`. BYOK invariant
 * (`prompt-prefix-cache` §5): derived ONLY from the tenant id + the
 * client-declared cachePrefixId — never from secret material (no API key, no
 * BYOK credential, no token). Deterministic so replay is unaffected (same scope
 * → same bytes → same request).
 */
export function cachePrefixScopeMarker(scope: CachePrefixScope): string {
  return `[openwop-cache-scope tenant=${scope.tenant} prefix=${scope.cachePrefixId}]`;
}

/**
 * Build the Anthropic `system` field. When caching is off, return the plain
 * string (byte-identical to today's request). When on, return a one-element
 * block array carrying the ephemeral cache breakpoint so the system prompt is
 * cached. Returns `undefined` for an absent/empty system so the caller omits the
 * field entirely (matching current behavior).
 *
 * RFC 0116 cross-tenant isolation (`prompt-prefix-cache-cross-tenant-isolation`):
 * when `scope` is supplied, the cached block text is prefixed with a per-tenant
 * marker, so tenant B's use of tenant A's `cachePrefixId` yields DIFFERENT prefix
 * bytes → Anthropic's content-addressed cache structurally MISSES (not host
 * bookkeeping — the strongest form of the guarantee). Same `(tenant,
 * cachePrefixId)` → identical bytes → a real cache hit.
 */
export function cacheableAnthropicSystem(
  system: string | undefined,
  enabled: boolean,
  scope?: CachePrefixScope,
): string | AnthropicSystemBlock[] | undefined {
  if (!system) return undefined;
  if (!enabled) return system;
  const text = scope ? `${cachePrefixScopeMarker(scope)}\n${system}` : system;
  return [{ type: 'text', text, cache_control: EPHEMERAL }];
}

/**
 * Return a NEW tools array with an ephemeral cache breakpoint on the LAST
 * element (so the whole tool block — including any appended server tools such as
 * web_search — is part of the cached prefix). Non-mutating: each element is
 * shallow-copied; the original array and its objects are untouched. When caching
 * is off, or there are no tools, the input is returned unchanged.
 */
export function withAnthropicToolCache<T extends AnthropicToolDef>(
  tools: readonly T[],
  enabled: boolean,
): readonly T[] {
  if (!enabled || tools.length === 0) return tools;
  const out = tools.map((t) => ({ ...t }));
  out[out.length - 1] = { ...out[out.length - 1], cache_control: EPHEMERAL };
  return out;
}

/** Cache-token counts read from an Anthropic `usage` block. Both keys are
 *  reported by Anthropic only when prompt caching is engaged; absent ⇒ 0. */
export interface AnthropicCacheTokens {
  /** Tokens served from cache this call (billed at ~0.1×). */
  cachedReadTokens: number;
  /** Tokens written to cache this call (billed at ~1.25×, one-time). */
  cacheWriteTokens: number;
}

/** Extract cache-read / cache-write token counts from an Anthropic `usage`
 *  object (`cache_read_input_tokens` / `cache_creation_input_tokens`). Tolerant
 *  of the absent/streaming shapes — returns zeros when the fields aren't present. */
export function extractAnthropicCacheTokens(usage: unknown): AnthropicCacheTokens {
  const u = (usage ?? {}) as { cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
  const read = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const write = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  return { cachedReadTokens: read, cacheWriteTokens: write };
}
