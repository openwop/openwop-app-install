/**
 * ADR 0710 — who a run notice is addressed to.
 *
 * ONE predicate, imported by every emit site that has to make this call. The
 * ADR's appendix found the same audience question answered independently at
 * eleven files, two of them *conditionally* (`...(recipientUserId ? {…} : {})`)
 * — which reads as targeted and silently broadcasts when the value is absent.
 * A rule copied per call site is an audience boundary that drifts; this module
 * exists so "who is told" has a single owner.
 *
 * The decision (ADR 0710 §Decision 2026-09-17):
 *
 *   - **Operator = the existing admin role.** No new notification role; ADR 0050
 *     Phase 3's `recipientRole` filter is used as it stands.
 *   - **Personal tenants keep today's behaviour.** In a `user:`/`anon:` workspace
 *     the owner IS the operator, so a broadcast and a role address coincide —
 *     and role-addressing there would be strictly worse: the read path is
 *     default-deny on `recipientRole`, so a solo user who is not carrying an
 *     `admin` role row would STOP SEEING THEIR OWN FAILURES. That is the whole
 *     reason this is a predicate and not a constant.
 *   - **A participant-facing run never produces a participant-visible failure
 *     notice.** Its feature decides whether to retry or say something kind.
 */
import { isPersonalTenantId } from '../host/requestSubject.js';

/**
 * Runs whose `metadata.purpose` marks them participant-facing (ADR 0710 §C, the
 * "small registry"). These execute headlessly ON BEHALF OF a participant who
 * never asked for a run and cannot act on a failure — so a `workflow.failed`
 * notice reaching them is an instruction addressed to someone without the
 * action.
 *
 * Adding a row here is an audience decision: it says "this job's failures are an
 * operator's problem". Values are the ones already written at the scheduling
 * sites, not new strings.
 */
export const PARTICIPANT_FACING_PURPOSES: ReadonlySet<string> = new Set([
  'kickbot-coach-turn',        // kickbotCoachTurnService.ts
  'kicktodo-reminder',         // enrollmentService.ts
  'kicktodo-session-reminder', // sessionService.ts
  'kicktodo-calendar-sync',    // calendarSyncService.ts
]);

export function isParticipantFacingRun(metadata: Record<string, unknown> | undefined): boolean {
  const purpose = metadata?.purpose;
  return typeof purpose === 'string' && PARTICIPANT_FACING_PURPOSES.has(purpose);
}

export interface RunNoticeAudience {
  /** Set on the emitted record. `undefined` keeps the tenant-wide broadcast. */
  readonly recipientRole?: 'admin';
  /** True when this notice should be aggregated to one per job per day. */
  readonly aggregatePerJobPerDay: boolean;
  /** Why — carried into the record's metadata so the choice is inspectable
   *  after the fact rather than re-derived by a reader. */
  readonly reason: 'personal-tenant-broadcast' | 'operator-role' | 'operator-role-participant-facing';
}

/**
 * The audience for a run-failure or open-gate notice.
 *
 * Shared tenants get the operator role — which is ALSO a correction to the
 * silent broadcast for ordinary workflows, not only for participant-facing ones
 * (ADR 0710 §Recommendation: "the default for a failed run with no
 * participant-facing marker becomes role-addressed to operators").
 */
export function runNoticeAudience(input: {
  tenantId: string;
  metadata?: Record<string, unknown> | undefined;
}): RunNoticeAudience {
  if (isPersonalTenantId(input.tenantId)) {
    return { aggregatePerJobPerDay: false, reason: 'personal-tenant-broadcast' };
  }
  return isParticipantFacingRun(input.metadata)
    ? { recipientRole: 'admin', aggregatePerJobPerDay: true, reason: 'operator-role-participant-facing' }
    : { recipientRole: 'admin', aggregatePerJobPerDay: false, reason: 'operator-role' };
}
