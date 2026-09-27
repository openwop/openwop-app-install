/**
 * ADR 0412 P3 — content-free goal lifecycle events on the host-extension bus.
 *
 * Event types are RFC 0086 §E host-namespaced (`host.goals.*`) — the canonical
 * RunEvent kinds `goal.evaluated`/`goal.closed` require a run context (the run
 * event log REQUIRES a runId, ADR 0208), while judge evaluations are route/
 * service-triggered. Payloads mirror the canonical run-event payload schemas
 * (`run-event-payloads.schema.json` §goalEvaluated/§goalClosed) exactly, so a
 * later run-integrated emission carries the identical shape.
 *
 * Two invariants from those schemas:
 *  - Content-free: goalId + verdict fields only — NO objective text, NO
 *    evidence refs.
 *  - "MUST NOT be emitted unless `capabilities.agents.goals` is advertised" —
 *    emission is gated on `OPENWOP_GOALS_ENABLED` (the ADR 0412 P0 guard keeps
 *    that flag off until P5, so nothing emits before the honesty flip).
 *
 * Best-effort: a fanout error never fails the judge write that preceded it.
 */

import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import type { GoalState, GoalVerdict } from './types.js';

const log = createLogger('goals.events');

export const GOAL_EVALUATED_EVENT = 'host.goals.evaluated';
export const GOAL_CLOSED_EVENT = 'host.goals.closed';

/** Terminal states a `host.goals.closed` event may carry. */
export type GoalFinalState = Exclude<GoalState, 'active'>;

function advertised(): boolean {
  return process.env.OPENWOP_GOALS_ENABLED === 'true';
}

export async function emitGoalEvaluated(
  tenantId: string,
  goalId: string,
  verdict: GoalVerdict,
  iterations: number,
): Promise<void> {
  if (!advertised()) return;
  try {
    await emitHostEvent({
      type: GOAL_EVALUATED_EVENT,
      tenantId,
      payload: {
        goalId,
        satisfied: verdict.satisfied,
        confidence: verdict.confidence,
        runId: verdict.runId,
        iterations,
      },
    });
  } catch (err) {
    log.warn('goal_event_emit_failed', { type: GOAL_EVALUATED_EVENT, goalId, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function emitGoalClosed(tenantId: string, goalId: string, finalState: GoalFinalState): Promise<void> {
  if (!advertised()) return;
  try {
    await emitHostEvent({ type: GOAL_CLOSED_EVENT, tenantId, payload: { goalId, finalState } });
  } catch (err) {
    log.warn('goal_event_emit_failed', { type: GOAL_CLOSED_EVENT, goalId, error: err instanceof Error ? err.message : String(err) });
  }
}
