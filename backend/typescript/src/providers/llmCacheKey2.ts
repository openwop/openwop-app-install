/**
 * RFC 0260 — LLM cache key recipe 2 (`openwop-llm-key-2`), ADR 1142.
 *
 *   key = hex(SHA-256(JCS({ recipe, model, provider, messages, tools, toolChoice,
 *                           responseSchema, params })))
 *
 * The rule that shapes this module is §B.1: the key hashes what the host SENDS to
 * the provider, and a named parameter it does not send is `null`. So the
 * parameters come from `sentSampling()`, the same function `dispatchPlain` uses to
 * build the request it hands the adapter, never from what the caller asked for.
 * No adapter here forwards `temperature` or `stop` to a real provider today
 * (ADR 1142 Context), and a key naming them would claim a request that never
 * happened.
 *
 * Off by default: `OPENWOP_LLM_CACHE_KEY_RECIPE_2` (`true` or `1`) turns it on,
 * read on every call. Off, nothing in this module runs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJSON } from '../host/jcs.js';
import type { ChatMessage } from './dispatch.js';

export const RECIPE_2 = 'openwop-llm-key-2';
export const RECIPE_2_FLAG = 'OPENWOP_LLM_CACHE_KEY_RECIPE_2';

/** The conformance mock's id and its one model (RFC 0260 fixture `conformance-llm-cache-key`). */
export const CONFORMANCE_MOCK_PROVIDER = 'conformance-mock';
export const CONFORMANCE_MOCK_MODEL = 'conformance-mock-1';

export function llmCacheKeyRecipe2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[RECIPE_2_FLAG] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** The eight parameters recipe 2 names (§B.1). */
export const NAMED_PARAMS = ['temperature', 'maxTokens', 'stop', 'seed', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty'] as const;
export type NamedParam = (typeof NAMED_PARAMS)[number];

type Forwarded = 'maxTokens' | 'temperature' | 'stop';

/**
 * ADR 1142 D3 — the parameters each provider adapter actually forwards. This is
 * the one place the claim lives: when an adapter starts sending a parameter, its
 * set grows in the same change. A provider not listed forwards `maxTokens` only.
 */
const SENT_PARAMS: Readonly<Record<string, readonly Forwarded[]>> = {
  mock: ['maxTokens', 'temperature', 'stop'],
  [CONFORMANCE_MOCK_PROVIDER]: ['maxTokens', 'temperature', 'stop'],
};
const DEFAULT_SENT: readonly Forwarded[] = ['maxTokens'];

export interface SamplingRequest {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: ReadonlyArray<string>;
}

/** The sampling fields the dispatch request carries for this provider: what is sent, and nothing else. */
export function sentSampling(provider: string, req: SamplingRequest): { maxTokens?: number; temperature?: number; stopSequences?: string[] } {
  const sends = SENT_PARAMS[provider] ?? DEFAULT_SENT;
  return {
    ...(sends.includes('maxTokens') && req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
    ...(sends.includes('temperature') && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(sends.includes('stop') && req.stopSequences && req.stopSequences.length > 0 ? { stopSequences: [...req.stopSequences] } : {}),
  };
}

export interface KeyInputs {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly unknown[];
  readonly toolChoice?: unknown;
  readonly responseSchema?: unknown;
  /** The sampling fields as sent, i.e. `sentSampling()`'s output. */
  readonly sent: { maxTokens?: number; temperature?: number; stopSequences?: readonly string[] };
}

const codeUnitCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * ADR 1142 D9 — test-seam-only sabotage, so each RFC 0260 leg can be shown red on
 * this host (RFC 0263 §C). Never read outside `OPENWOP_TEST_SEAM_ENABLED`.
 */
export type Sabotage = 'omit' | 'drop-max-tokens' | 'nonce' | 'model';
export function llmKeySabotage(env: NodeJS.ProcessEnv = process.env): Sabotage | null {
  if (env.OPENWOP_TEST_SEAM_ENABLED !== 'true') return null;
  const v = env.OPENWOP_SABOTAGE_LLM_KEY;
  return v === 'omit' || v === 'drop-max-tokens' || v === 'nonce' || v === 'model' ? v : null;
}

/** The object recipe 2 hashes (§B), before canonicalization. */
export function keyPreimage(i: KeyInputs, sabotage: Sabotage | null = null): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const name of NAMED_PARAMS) params[name] = null;
  if (i.sent.maxTokens != null && sabotage !== 'drop-max-tokens') params['maxTokens'] = i.sent.maxTokens;
  if (typeof i.sent.temperature === 'number') params['temperature'] = i.sent.temperature;
  if (i.sent.stopSequences && i.sent.stopSequences.length > 0) params['stop'] = [...new Set(i.sent.stopSequences)].sort(codeUnitCompare);
  // §B.1 `params.extra`: no adapter here sends an unnamed sampling parameter, so it is always omitted.
  return {
    recipe: RECIPE_2,
    model: sabotage === 'model' ? `${i.model}-sabotaged` : i.model,
    provider: i.provider,
    // §B.2 — a string content becomes the one-part text array; no Unicode normalisation.
    messages: i.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content })),
    tools: i.tools ?? [],
    toolChoice: i.toolChoice ?? null,
    responseSchema: i.responseSchema ?? null,
    params,
    ...(sabotage === 'nonce' ? { nonce: randomUUID() } : {}),
  };
}

export function cacheKey2(i: KeyInputs, sabotage: Sabotage | null = null): string {
  return createHash('sha256').update(canonicalJSON(keyPreimage(i, sabotage)), 'utf8').digest('hex');
}

/**
 * The stored form (`invocation_log.llm_cache_key`, `"<recipe>:<digest>"`), or
 * undefined when recipe 2 is off, or under the `omit` sabotage. The caller writes
 * it on every LLM provider call record (§C.1).
 */
export function storedLlmCacheKey(i: KeyInputs): string | undefined {
  if (!llmCacheKeyRecipe2Enabled()) return undefined;
  const sabotage = llmKeySabotage();
  if (sabotage === 'omit') return undefined;
  return `${RECIPE_2}:${cacheKey2(i, sabotage)}`;
}

/**
 * RFC 0260 §C.3 — may a recorded result be served to this invocation? A record
 * with no recipe-2 key was recorded under RFC 0041's recipe, so this judge has no
 * say (true). One with a key matches only its own recipe-2 key, recomputed here
 * whether or not the flag is on now: the record names its recipe.
 */
export function recipe2Matches(stored: string | null | undefined, i: KeyInputs): boolean {
  if (!stored || !stored.startsWith(`${RECIPE_2}:`)) return true;
  return stored === `${RECIPE_2}:${cacheKey2(i)}`;
}

/** The projection's `cacheKey` from a stored value; anything malformed projects nothing. */
export function projectLlmCacheKey(stored: string | null | undefined): { recipe: string; digest: string } | undefined {
  if (!stored) return undefined;
  const i = stored.lastIndexOf(':');
  const recipe = stored.slice(0, i);
  const digest = stored.slice(i + 1);
  return recipe === RECIPE_2 && /^[0-9a-f]{64}$/.test(digest) ? { recipe, digest } : undefined;
}
