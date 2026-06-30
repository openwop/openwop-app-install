/**
 * Boardroom turn planner (ADR 0043 Phase 5A / ADR 0040 increment 2).
 *
 * Given a board's cohort + its turn policy, produces the deterministic ORDER in
 * which advisors speak after the chair's opening — one voice at a time, like a
 * real moderated boardroom. The chair's framing is the user's own `@@<board>`
 * turn (already routed to the chair), so this plans the FOLLOW-UP turns:
 *   - each advisor (excluding the chair) speaks once per round, in `declared`
 *     order or `round-robin` (the starting advisor rotates each round);
 *   - after the rounds, if `synthesize` and a chair exists, the chair closes
 *     with a synthesis turn.
 *
 * Pure + side-effect-free so the cadence ORDER is unit-testable in isolation;
 * `useBoardroomCadence` consumes the plan and drives the live dispatch.
 */

/** Order a convene cohort (ADR 0054 D6): the chair (moderator, only when it's a
 *  member) first, then the remaining agent members in declared order, bounded by
 *  `cap` for cost. Pure so the cohort selection is unit-testable. A moderator that
 *  isn't in `memberRosterIds` is ignored — the chair must be in the room. */
export function orderConveneCohort(
  moderatorRosterId: string | undefined,
  memberRosterIds: readonly string[],
  cap: number,
): string[] {
  const chair = moderatorRosterId && memberRosterIds.includes(moderatorRosterId) ? moderatorRosterId : undefined;
  return [
    ...(chair ? [chair] : []),
    ...memberRosterIds.filter((id) => id !== chair),
  ].slice(0, Math.max(0, cap));
}

export type BoardroomTurnKind = 'advisor' | 'synthesis';

export interface BoardroomTurn {
  /** The agent that takes this turn. */
  agentId: string;
  kind: BoardroomTurnKind;
  /** 0-based round index (the synthesis turn is stamped with `rounds`). */
  round: number;
}

export interface BoardroomCohort {
  /** The moderator/chair (frames + synthesizes). When a board has no moderator,
   *  the caller passes the agent that took the opening turn so it isn't also
   *  rotated as an advisor. */
  chairAgentId: string | null;
  /** Every advisor in declared order (the chair is filtered out below). */
  advisorAgentIds: string[];
}

export interface BoardroomTurnPolicy {
  rounds: number;
  order: 'declared' | 'round-robin';
  synthesize: boolean;
}

/** Plan the advisor (+ optional synthesis) turns that follow the chair's
 *  opening. Returns [] when there are no advisors and no synthesis to run. */
export function planBoardroomTurns(cohort: BoardroomCohort, policy: BoardroomTurnPolicy): BoardroomTurn[] {
  const advisors = cohort.advisorAgentIds.filter((id) => id && id !== cohort.chairAgentId);
  const rounds = Math.max(1, Math.floor(policy.rounds || 1));
  const turns: BoardroomTurn[] = [];
  for (let r = 0; r < rounds && advisors.length > 0; r++) {
    // round-robin rotates the starting advisor each round so the same voice
    // doesn't always lead; declared keeps the authored order every round.
    const order = policy.order === 'round-robin'
      ? advisors.map((_, i) => advisors[(i + r) % advisors.length] as string)
      : advisors;
    for (const agentId of order) turns.push({ agentId, kind: 'advisor', round: r });
  }
  if (policy.synthesize && cohort.chairAgentId) {
    turns.push({ agentId: cohort.chairAgentId, kind: 'synthesis', round: rounds });
  }
  return turns;
}
