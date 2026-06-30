/**
 * ADR 0130 Phase 3b — apply a stamped route at dispatch (replay-safe READ side).
 *
 * The routing DECISION is stamped once into `run.metadata.modelRoute` at run
 * creation (Phase 3c, the write side); dispatch reads it verbatim here. So a
 * `:fork` re-runs with the SAME provider/model the original resolved — the router
 * never re-evaluates on replay (deterministic, ADR 0001 stamp pattern). With no
 * stamp, the run's explicit provider/model is returned unchanged.
 */

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
      return { provider: typeof s.provider === 'string' && s.provider.length > 0 ? s.provider : provider, model: s.model };
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
