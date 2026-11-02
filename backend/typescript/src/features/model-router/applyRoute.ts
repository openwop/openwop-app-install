/**
 * ADR 0130 Phase 3b — the conversation model-target resolver (pure).
 *
 * ADR 1016 D3 — the route is decided per EXCHANGE (`resolveTurnModelRoute`) and
 * reaches every dispatch lane as this resolver's `route` input; it is no longer
 * stamped. A `run.metadata.modelRoute` stamp written before ADR 1016 is still
 * read (`effectiveModelTarget`), so an adopter's older conversations do not change
 * model under them — unless the conversation cannot call it (D3/L4 below).
 */

import { getClassDefault, listProviders } from '../../providers/catalog.js';
import { dispatchableProviderOf, isRoutableProvider } from './routableProviders.js';

export interface ModelTarget { provider: string | undefined; model: string }

/** The chat providers the catalog knows — the list a LEGACY stamp is judged
 *  against (this pure module never imports the provider host's full
 *  `CREDENTIAL_PROVIDERS`; a chat stamp only ever names a chat provider). */
const CATALOG_PROVIDER_IDS: readonly string[] = listProviders().map((p) => p.id);

/** Returns the effective {provider, model}: the stamped route if present + valid,
 *  else the run's own (provider, model). Pure. Judges the stamp only by the
 *  routable allowlist; `resolveConversationModelTarget` (the dispatch path) ALSO
 *  ignores a stamp the conversation cannot call (ADR 1016, architect L4). */
export function effectiveModelTarget(
  provider: string | undefined,
  model: string,
  metadata: Record<string, unknown> | undefined,
): ModelTarget {
  return readStamp(provider, metadata, undefined) ?? { provider, model };
}

/** The stamp, if valid. `credentialRef === undefined` skips the callability
 *  check (the bare `effectiveModelTarget` read); anything else is judged with
 *  `dispatchableProviderOf` (a non-string ref is the managed default). */
function readStamp(
  provider: string | undefined,
  metadata: Record<string, unknown> | undefined,
  credentialRef: unknown,
): ModelTarget | null {
  const stamped = metadata?.['modelRoute'];
  if (stamped && typeof stamped === 'object') {
    const s = stamped as { provider?: unknown; model?: unknown };
    if (typeof s.model === 'string' && s.model.length > 0) {
      const stampedProvider = typeof s.provider === 'string' && s.provider.length > 0 ? s.provider : undefined;
      // ADR 0610 D4 / MRC-2 — the READ-side guard the write-time allowlist pairs
      // with. A stamp written BEFORE the allowlist (or a tampered/forked one) that
      // names a NON-routable provider must NOT dispatch verbatim: ignore the whole
      // stamp → fall back to the run's explicit provider/model. A stamp with no
      // provider keeps the run's own (never an exfil target), so it's not gated.
      if (stampedProvider === undefined || isRoutableProvider(stampedProvider)) {
        const target = { provider: stampedProvider ?? provider, model: s.model };
        if (credentialRef === undefined) return target;
        const callable = dispatchableProviderOf({ provider, credentialRef }, CATALOG_PROVIDER_IDS);
        return callable !== null && callable === target.provider ? target : null;
      }
    }
  }
  return null;
}

/** ADR 0124 Phase 3 — layer a per-EXCHANGE model switch over the resolved target.
 *  Highest precedence (override > route stamp > run inputs); a partial override
 *  (model only, or provider only) keeps the other field. Pure. */
export function applyExchangeOverride(base: ModelTarget, override: { provider?: string; model?: string } | undefined): ModelTarget {
  if (!override) return base;
  return {
    provider: override.provider ?? base.provider,
    model: override.model ?? base.model,
  };
}

/** The conversation-tier inputs a dispatch site knows about its turn — the
 *  server-derived conversation type (ConversationMeta, never client-asserted)
 *  and the ANSWERING agent's declared modelClass. */
export interface ConversationModelTierInput {
  conversationType?: string | undefined;
  agentModelClass?: string | undefined;
}

/**
 * CS-GB-1 (conversation-stack audit 2026-07-09) — the ONE conversation
 * model-target resolver.
 *
 * ADR 1016 D4b — precedence is now: exchange override > THIS TURN'S ROUTE >
 * legacy stamp > same-provider class tier > run inputs. A route counts as
 * "chosen", so it suppresses the class bump (a tenant rule wins over that host
 * default, ADR 0130 Phase 6). The route is its own input, NOT folded into the
 * override: every lane's degrade-once fallback is the resolve WITHOUT the route
 * and WITHOUT the tier (`unchosenModelTarget`), and that only exists if the
 * route stays distinguishable from the user's own choice. Both chat dispatch sites (the single-completion
 * `dispatchReply` AND the tool loop) and the `agent.model` provenance stamp
 * MUST resolve through this function; before it, the tool loop read raw
 * `run.inputs` — ignoring the route stamp AND the in-chat model override —
 * and neither site honored an agent's `modelClass` (the "board advisors
 * answer on the cheap tier" incident, ADR 0130 Phase 6).
 *
 * Precedence: exchange override > stamped route > SAME-provider class-tier
 * default > run inputs. The class bump applies only for a `group`
 * conversation whose answering agent declares `modelClass:'reasoning'`, only
 * when neither a stamp nor an override chose the model, and only WITHIN the
 * already-resolved provider (providers.json `classDefaults` — the tenant's
 * key keeps working; ADR 0130 Phase 6's "no cross-provider auto-bump" ruling
 * stands, corrected from "tenant-authored only" to "host default, same
 * provider"). Pure given the catalog.
 */
export interface ConversationModelTargetInput {
  runInputs: { provider?: unknown; model?: unknown; credentialRef?: unknown };
  metadata: Record<string, unknown> | undefined;
  override?: { provider?: string; model?: string } | undefined;
  tier?: ConversationModelTierInput | undefined;
  /** ADR 1016 — this exchange's router decision (`resolveTurnModelRoute`). */
  route?: { provider: string; model: string } | null | undefined;
}

export function resolveConversationModelTarget(input: ConversationModelTargetInput): ModelTarget {
  const ownProvider = typeof input.runInputs.provider === 'string' ? input.runInputs.provider : undefined;
  // `?? null`: a run with no ref dispatches on the managed default, so its stamp is judged too.
  const stamp = readStamp(ownProvider, input.metadata, input.runInputs.credentialRef ?? null);
  const base: ModelTarget = input.route
    ? { provider: input.route.provider, model: input.route.model }
    : stamp ?? { provider: ownProvider, model: typeof input.runInputs.model === 'string' ? input.runInputs.model : 'unknown' };
  const target = applyExchangeOverride(base, input.override);
  const modelWasChosen = !!input.route || !!stamp || typeof input.override?.model === 'string';
  if (
    !modelWasChosen
    && input.tier?.conversationType === 'group'
    && input.tier?.agentModelClass === 'reasoning'
    && target.provider
  ) {
    const bump = getClassDefault(target.provider, 'reasoning');
    if (bump && bump !== target.model) return { provider: target.provider, model: bump };
  }
  return target;
}

/**
 * ADR 1016 D4b — the selection with NEITHER the route NOR the class tier: the
 * model a lane degrades to, once, when the chosen model cannot serve this key
 * (429 quota / 404 access). `null` when nothing but the user's own selection
 * chose the model, i.e. there is nothing distinct to fall back to.
 */
export function unchosenModelTarget(input: ConversationModelTargetInput, chosen: ModelTarget): ModelTarget | null {
  const { route: _route, tier: _tier, ...rest } = input;
  const unchosen = resolveConversationModelTarget(rest);
  return unchosen.provider === chosen.provider && unchosen.model !== chosen.model ? unchosen : null;
}
