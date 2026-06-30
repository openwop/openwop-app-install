/**
 * Shared turn-policy primitive (ADR 0040 / ADR 0054 D6).
 *
 * The ONE validator for a bounded multi-agent cadence policy — consumed by BOTH
 * the advisory board (cohort = `advisors[]`) and a project's group chat (cohort =
 * agent members), which run on the same `planBoardroomTurns` cadence on the
 * frontend. Single-sourced so the two callers cannot drift (the orgs↔accessControl
 * second-owner lesson): the policy VALUE may live on each entity, but the
 * validator + the cadence planner are shared.
 */

/** A bounded multi-agent turn policy. `rounds` is clamped to
 *  `[1, TURN_POLICY_MAX_ROUNDS]` for cost (the cadence fan-out cap). */
export interface TurnPolicy {
  rounds: number;
  order: 'declared' | 'round-robin';
  synthesize: boolean;
}

/** Max cadence rounds (cost cap; ADR 0040 § Open questions). */
export const TURN_POLICY_MAX_ROUNDS = 3;

/** Validate + normalize a turn policy from untrusted input. Defaults: `rounds` 1,
 *  `order` `'declared'`, `synthesize` `true`. Never throws — clamps instead, so
 *  callers can pass a raw request body without a cast. */
export function parseTurnPolicy(input: unknown): TurnPolicy {
  const v = input && typeof input === 'object' ? input as { rounds?: unknown; order?: unknown; synthesize?: unknown } : undefined;
  const rounds = typeof v?.rounds === 'number' && Number.isFinite(v.rounds)
    ? Math.min(TURN_POLICY_MAX_ROUNDS, Math.max(1, Math.floor(v.rounds)))
    : 1;
  const order = v?.order === 'round-robin' ? 'round-robin' : 'declared';
  const synthesize = v?.synthesize === undefined ? true : Boolean(v.synthesize);
  return { rounds, order, synthesize };
}
