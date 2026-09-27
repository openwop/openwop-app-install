/**
 * Plan-revised hook (KickTodo plan changes → interested projections).
 *
 * A neutral host-level seam, modelled on `subjectErasure`: kicktodo-core owns the
 * plan and announces that one was revised; features that PROJECT a plan elsewhere
 * (today: kicktodo-integrations' calendar write) register a listener. Neither
 * feature imports the other, so there is no cross-feature edge for the ADR 0446
 * classifier to see, and the hard-dep count stays at zero.
 *
 * WHY THIS EXISTS RATHER THAN A DIRECT CALL (ENG-15(b), 2026-07-28). The first
 * implementation had `replanService` import `calendarWriteService` directly. It
 * worked and was fail-soft, but it took the classifier's `[3] Hard-dep` count from
 * 0 to 1 and `feature-deps-classifier.test.ts` asserts that count is ZERO. The
 * classifier was technically wrong about that edge — it reads the TARGET (which
 * refuses when the feature is off) and cannot see the call site swallowed exactly
 * that refusal — but "the ratchet is wrong about my edge" is a reason to fix the
 * edge, not to raise the ratchet. This is the fixed edge.
 *
 * CONTRACT for listeners:
 *  - FAIL-SOFT is enforced HERE, not left to each listener. The revision is the
 *    participant's durable intent and is already committed before this fires; a
 *    projection failing must never surface as a failed revision. A throwing
 *    listener is logged and swallowed, and one listener's failure does not stop
 *    the next.
 *  - Listeners run AFTER the revision is durable, never before.
 *  - Registration is module-load and process-global (the 74-seam house pattern).
 */

import { createLogger } from '../observability/logger.js';

const log = createLogger('host.planRevised');

/** What a projection needs to re-derive its view of the plan. */
export interface PlanRevisedEvent {
  tenantId: string;
  /** The participant who owns the plan — the subject a projection is scoped to. */
  ownerSubject: string;
  enrollmentId: string;
  /** The lanes the revision actually touched, so a listener can ignore ones that
   *  cannot affect it (a calendar cares about `move`; it does not care about a
   *  daypart preference). Keeps a preference tweak from becoming an external write. */
  lanes: readonly string[];
}

type PlanRevisedListener = (ev: PlanRevisedEvent) => Promise<void> | void;

const listeners = new Set<PlanRevisedListener>();

/** Register a projection. Idempotent per function identity. */
export function registerPlanRevisedListener(fn: PlanRevisedListener): void {
  listeners.add(fn);
}

/** Test seam — drop all listeners so cases do not leak into each other. */
export function __resetPlanRevisedListenersForTest(): void {
  listeners.clear();
}

/**
 * Announce a durable plan revision. Awaits listeners so a caller CAN sequence on
 * them, but never rejects: every listener error is contained here.
 */
export async function emitPlanRevised(ev: PlanRevisedEvent): Promise<void> {
  for (const fn of listeners) {
    try {
      await fn(ev);
    } catch (err) {
      // Contained deliberately — see the fail-soft contract above. Logged at info
      // rather than warn because the commonest cause is "this participant has no
      // calendar connected", which is not an operator problem.
      log.info('plan_revised_listener_failed', {
        enrollmentId: ev.enrollmentId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
