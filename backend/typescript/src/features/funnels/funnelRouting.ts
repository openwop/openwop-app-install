/**
 * Funnel step routing (ADR 0294 / Funnel A, Phase 2) — a PURE function from
 * (funnel, from-step, visitor context) to the next step. Per the ADR ruling:
 * request-time, per-visitor decisions live here; anything time-based or
 * contact-based (abandonment timers, nurture) is an EVENT handled by journeys
 * (ADR 0222/0267) — this module must never grow a scheduler or state.
 *
 * Rule semantics: a step's `routing` rules are evaluated in order; the first
 * rule whose `when` conditions ALL hold (an absent `when` always matches)
 * routes to its `goto` step. No rule match ⇒ the next step in order; past the
 * last step ⇒ null (funnel complete). Segment-membership predicates are a
 * recorded deferral (they need the consented identity join, ADR 0294 P3+).
 */

export const STEP_OUTCOMES = ['accepted', 'declined'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

export interface StepRule {
  when?: {
    /** Matches the outcome the renderer reported for the completed step
     *  (e.g. an upsell offer accepted vs declined). */
    outcome?: StepOutcome;
    /** Matches a UTM parameter carried on the visitor's navigation. */
    utm?: { key: string; value: string };
  };
  /** The stepId to route to (validated against the funnel's steps at write). */
  goto: string;
}

export interface RoutingContext {
  outcome?: StepOutcome;
  utm?: Record<string, string>;
}

interface RoutableStep { stepId: string; routing?: StepRule[] }

function ruleMatches(rule: StepRule, ctx: RoutingContext): boolean {
  const when = rule.when;
  if (!when) return true;
  if (when.outcome !== undefined && when.outcome !== ctx.outcome) return false;
  if (when.utm !== undefined && (ctx.utm?.[when.utm.key] ?? null) !== when.utm.value) return false;
  return true;
}

/**
 * Resolve the index of the step AFTER `fromStepId`. Returns the next step's
 * index, or null when the funnel is complete, or `{ error }` when the from
 * step is unknown (the route maps it to a 400 — a stale/forged step id must
 * fail loudly, not restart the funnel).
 */
export function resolveNextStepIx(
  steps: readonly RoutableStep[],
  fromStepId: string,
  ctx: RoutingContext,
): { ix: number } | { complete: true } | { error: 'unknown_step' } {
  const fromIx = steps.findIndex((s) => s.stepId === fromStepId);
  if (fromIx === -1) return { error: 'unknown_step' };
  for (const rule of steps[fromIx].routing ?? []) {
    if (ruleMatches(rule, ctx)) {
      const targetIx = steps.findIndex((s) => s.stepId === rule.goto);
      // A dangling goto is prevented at write; if one slips through (e.g. a
      // partial future edit), fall through to sequential rather than crash.
      if (targetIx !== -1) return { ix: targetIx };
    }
  }
  const nextIx = fromIx + 1;
  return nextIx < steps.length ? { ix: nextIx } : { complete: true };
}
