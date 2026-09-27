/**
 * ADR 0130 Phase 3b — apply a stamped route at dispatch (replay-safe READ side).
 *
 * The routing DECISION is stamped once into `run.metadata.modelRoute` at run
 * creation (Phase 3c, the write side); dispatch reads it verbatim here. So a
 * `:fork` re-runs with the SAME provider/model the original resolved — the router
 * never re-evaluates on replay (deterministic, ADR 0001 stamp pattern). With no
 * stamp, the run's explicit provider/model is returned unchanged.
 */

import { getClassDefault } from '../../providers/catalog.js';
import { isRoutableProvider } from './routableProviders.js';

export interface ModelTarget { provider: string | undefined; model: string }

/** Returns the effective {provider, model}: the stamped route if present + valid,
 *  else the run's own (provider, model). Pure. */
export function effectiveModelTarget(
  provider: string | undefined,
  model: string,
  metadata: Record<string, unknown> | undefined,
): ModelTarget {
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
        return { provider: stampedProvider ?? provider, model: s.model };
      }
    }
  }
  return { provider, model };
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
 * model-target resolver. Both chat dispatch sites (the single-completion
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
export function resolveConversationModelTarget(input: {
  runInputs: { provider?: unknown; model?: unknown };
  metadata: Record<string, unknown> | undefined;
  override?: { provider?: string; model?: string } | undefined;
  tier?: ConversationModelTierInput | undefined;
}): ModelTarget {
  const base = effectiveModelTarget(
    typeof input.runInputs.provider === 'string' ? input.runInputs.provider : undefined,
    typeof input.runInputs.model === 'string' ? input.runInputs.model : 'unknown',
    input.metadata,
  );
  const target = applyExchangeOverride(base, input.override);
  const modelWasChosen = !!input.metadata?.['modelRoute'] || typeof input.override?.model === 'string';
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
