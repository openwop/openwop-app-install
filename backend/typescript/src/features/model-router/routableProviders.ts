/**
 * ADR 0610 D4 / MRC-2 — the closed-world catalog a model-router routing target may
 * name. A rule routes a run's prompts to `{provider, model}` on the run's EXISTING
 * credentialRef; without this allowlist a `workspace:write` editor could route org
 * prompt data to an arbitrary external vendor (or the `compat` custom-endpoint — the
 * arbitrary-URL egress hole). The set is the sanctioned user BYOK providers: the
 * catalog's `!managed && !hidden` list (ADR 0990 D6), so MiniMax (free tier only)
 * and `compat`/`mock` (custom/test endpoints) are excluded.
 *
 * A tiny PURE module so both the write gate (`configService.asTarget`) and the
 * read gate (`applyRoute.effectiveModelTarget` — dispatch/`:fork`) share the ONE
 * predicate without dragging the heavier `configService` (a `DurableCollection`
 * owner) into the pure dispatch-read path.
 *
 * ADR 1016 adds the two other questions every gate asks of a target, kept here
 * for the same reason (import-free leaves only): is the MODEL listed for that
 * provider (`listedModelCapabilities`, the per-model vision answer too), and
 * which ONE provider can this conversation's credential call
 * (`dispatchableProviderOf`).
 */
import { getProviderConfig, listSelectableProviderIds } from '../../providers/catalog.js';
import { probeProviderCapabilities } from '../../host/modelCapabilityProbe.js';
import { refNamedProvider } from '../../aiProviders/credentialRefLadder.js';
import { OWNED_REF_PREFIXES } from '../../byok/refNamespaces.js';

export const ROUTABLE_PROVIDERS: readonly string[] = listSelectableProviderIds();

/** True when `provider` is a sanctioned routing target. Used at WRITE (reject a bad
 *  rule) AND at READ/dispatch (ignore a legacy/tampered/forked stamp). */
export function isRoutableProvider(provider: string): boolean {
  return ROUTABLE_PROVIDERS.includes(provider);
}

/** True when `providers.json` lists `model` for `provider` (ADR 1016 D5 — the
 *  closed-world write check). */
export function isListedModel(provider: string, model: string): boolean {
  return getProviderConfig(provider)?.models.some((m) => m.id === model) ?? false;
}

/**
 * ADR 1016 D4 — the routing capability probe, per MODEL. `null` when the catalog
 * does not list the model (never routed to). Otherwise the provider's RFC 0031
 * capabilities, minus `vision-input` when THIS model's catalog entry lacks
 * `vision` — the per-provider probe alone answered "vision-capable" for any model
 * of a provider that had one (MR66WF-4).
 */
export function listedModelCapabilities(provider: string, model: string): readonly string[] | null {
  const entry = getProviderConfig(provider)?.models.find((m) => m.id === model);
  if (!entry) return null;
  const caps = probeProviderCapabilities(provider);
  return entry.capabilities.includes('vision') ? caps : caps.filter((c) => c !== 'vision-input');
}

/** The run inputs the dispatch decision reads. */
export interface DispatchInputs { provider?: unknown; credentialRef?: unknown }

/**
 * ADR 1016 D4 — the ONE provider this conversation's credential can call, or
 * `null` when the router does not apply to it at all.
 *
 * Mirrors `dispatchReply`'s branches (`host/exchange/dispatchTurn.ts`), including
 * its default ref:
 *  - `managed:*` (the default when no ref is set), `subscription:*`, and the
 *    `compat`/`mock` providers dispatch without honouring a routed provider/model,
 *    so they are never routed (MRC-4: a stamp there was ignored by dispatch but
 *    still named in the turn's provenance);
 *  - a BYOK ref that NAMES a provider (`google`, `byok:openai:…`) can only call
 *    that one. `credentialProviders` MUST be the list the dispatch guard judges
 *    (`CREDENTIAL_PROVIDERS`), so this and `explicitRefNamesOtherProvider` agree;
 *  - a provider-less ref (`my-key`) can only call the provider the conversation
 *    was opened on. This rule is load-bearing: the dispatch guard lets a
 *    provider-less ref through to ANY vendor, so this is the only check there.
 */
export function dispatchableProviderOf(inputs: DispatchInputs, credentialProviders: readonly string[]): string | null {
  const ref = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : `${OWNED_REF_PREFIXES.managed}openwop-free`;
  if (ref.startsWith(OWNED_REF_PREFIXES.managed) || ref.startsWith(OWNED_REF_PREFIXES.subscription)) return null;
  const own = typeof inputs.provider === 'string' && inputs.provider.length > 0 ? inputs.provider : null;
  if (own === 'compat' || own === 'mock') return null;
  return refNamedProvider(ref, credentialProviders) ?? own;
}
