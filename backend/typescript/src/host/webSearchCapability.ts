/**
 * Web-search capability + SUITABILITY — the one predicate for "can this
 * (provider, model) search the web, and may its results be STORED as durable
 * evidence?"
 *
 * ADR 0101 decided web search is ONE capability with provider-aware backing:
 * native (the user's own LLM key) → host tool (a BYOK `web-search` secret) →
 * none, "an explicit not-configured signal, never a stub". That was implemented
 * for the chat/agent lane; the workflow lane still fell back to `engine:'demo'`,
 * which is the same silent-stub bug ADR 0101 was written to kill and ADR 0491
 * hit again from the other end.
 *
 * TWO INDEPENDENT FACTS, deliberately kept apart:
 *
 *   1. CAPABILITY — does this MODEL do native search? Per-model `webSearch` in
 *      `providers.json` (the SSoT). Today only Google's models are `true`;
 *      Anthropic/OpenAI are implemented in the dispatchers but flagged OFF
 *      pending a live check (`dispatchProviderTools.ts` — "the model webSearch
 *      flag stays off until that check (capability honesty)"). Reading the flag
 *      rather than the dispatcher keeps that honesty intact.
 *
 *   2. SUITABILITY — may the results be extracted into a durable artifact?
 *      That is a LICENSING fact, per provider, and it cannot be inferred from
 *      capability. Google's Gemini API terms for Grounding with Google Search
 *      state the developer "will not modify, or intersperse any other content
 *      with, the Grounded Results", will not "redirect end users away from the
 *      destination pages", and may not "extract or collect one or more of these
 *      components for another purpose" — and storing/resubmitting Grounded
 *      Results obliges displaying the accompanying Search Suggestions. Grounding
 *      Links are licensed to be shown WITH the grounded answer, not harvested
 *      into a separate durable record.
 *
 * Why the distinction is load-bearing here: the KickTodo Challenge Factory's
 * evidence dossier stores "REFS + hashes only" and hashes `sourceHash(url,
 * title)` — the URL IS the evidence, it outlives the run, and a human approves a
 * publication on the strength of it. Backing that with `answer-only` links would
 * be both a licensing breach and (because Google returns per-request
 * `vertexaisearch…/grounding-api-redirect/<token>` URIs, not publisher URLs) a
 * provenance defect: the same article would hash differently on every run.
 *
 * So a caller that needs storable citations asks for `'durable'`, and a provider
 * that only grounds an answer can never silently back it.
 */

import { getProviderConfig } from '../providers/catalog.js';
import { getSearchVendor } from './searchVendors.js';

/**
 * How a provider's native search results may be used.
 *  - `durable`     — real publisher URLs, storable as citations in a durable artifact.
 *  - `answer-only` — licensed for display WITH the grounded answer it produced; MUST NOT
 *                    be harvested into a separate stored record (see Google above).
 *  - `none`        — no native search.
 */
export type SearchSuitability = 'durable' | 'answer-only' | 'none';

/** Read the provider-level licensing tier from the SSoT. Unknown ⇒ `none` (fail closed). */
function providerSuitability(providerId: string): SearchSuitability {
  const cfg = getProviderConfig(providerId);
  const raw = cfg?.searchSuitability;
  return raw === 'durable' || raw === 'answer-only' ? raw : 'none';
}

/** Does this specific MODEL advertise native web search? (per-model SSoT flag) */
export function modelSupportsNativeSearch(providerId: string, modelId: string): boolean {
  const cfg = getProviderConfig(providerId);
  if (!cfg) return false;
  return cfg.models.some((m) => m.id === modelId && m.webSearch === true);
}

/**
 * The combined answer: what this (provider, model) pair may actually be used for.
 * `none` when the model doesn't search OR the provider's terms don't permit any
 * programmatic use — both are fail-closed.
 */
export function nativeSearchSuitability(providerId: string, modelId: string): SearchSuitability {
  if (!modelSupportsNativeSearch(providerId, modelId)) return 'none';
  return providerSuitability(providerId);
}

/**
 * Does this pair satisfy a caller needing `required`? `durable` satisfies both
 * asks; `answer-only` satisfies only an `answer-only` ask. Callers that persist
 * citations (evidence dossiers, published artifacts) MUST pass `'durable'`.
 */
export function nativeSearchSatisfies(
  providerId: string,
  modelId: string,
  required: 'durable' | 'answer-only',
): boolean {
  const s = nativeSearchSuitability(providerId, modelId);
  return required === 'durable' ? s === 'durable' : s !== 'none';
}

/**
 * May results carrying this `engine` tag be stored as durable citations?
 *
 * The engine tag is what actually survives into a stored artifact (the dossier
 * records `s.engine` per source), so this — not the caller's intent — is the
 * authoritative gate at the point of persistence. Derived from the SSoT for
 * native engines rather than a hand-kept allowlist, so a provider whose terms
 * change is corrected in one place.
 *
 * Defence in depth: `search()` already asks for a suitability tier, but the host
 * key can fail at runtime and fall through to the native leg, so the consumer
 * that PERSISTS must check the engine it actually got.
 */
export function engineIsDurable(engine: string): boolean {
  const e = engine?.trim().toLowerCase();
  if (!e) return false;

  // 1. SYNTHETIC — never evidence, whatever else is true.
  if (e === 'demo' || e === 'stub') return false;

  // 2. UNATTRIBUTED — `kicktodo-creator/surface.ts` defaults a missing engine to
  //    'unknown', so an unattributed source would otherwise be indistinguishable
  //    from a real one. A citation whose provenance nobody recorded is not
  //    evidence. (This is the fail-open the first cut of this function had.)
  if (e === 'unknown') return false;

  // 3. NATIVE — a provider's own search. Durable only if its TERMS permit the
  //    results to be stored (see the header): capability is not permission.
  if (e.startsWith('native:')) return providerSuitability(e.slice('native:'.length)) === 'durable';

  // 4a. A vendor the app SHIPS a descriptor for answers from that descriptor, so
  //     `searchVendors.ts` is the SSoT for the ones we actually dispatch to.
  const known = getSearchVendor(e);
  if (known) return known.suitability === 'durable';

  // 4b. Any OTHER named host search vendor — searx, or whatever endpoint an
  //    operator configured. Deliberately open: the set is not enumerable (any
  //    self-hosted or future vendor is valid) and these return real publisher URLs
  //    under the operator's own contract. An earlier revision allowlisted only
  //    `brave` + OPENWOP_WEBSEARCH_ENGINE, which wrongly rejected `searx` — a real
  //    engine already in the seeded corpus.
  //
  //    Residual risk, stated: a model composing dossier JSON could invent a
  //    plausible vendor name. The compensating controls are the URL-level rights
  //    gate and the re-derived source hash, which is the same posture that existed
  //    before this gate — the tightening above is strictly additive to it.
  return true;
}
