/**
 * Privacy projections + circle feed + nudges (ADR 0419 P2; PRD §10.2).
 *
 * The projection is a PURE FIELD ALLOWLIST over kicktodo-core's rebuildable
 * progress — "generated from a field allowlist, not by asking a model to
 * 'remove sensitive information'". Floors that hold regardless of scopes:
 *
 *  - measured values NEVER project (no scope grants them in P2 — a sensitive-
 *    metrics scope would be a deliberate future addition);
 *  - journal note text projects ONLY under `check-in-note`;
 *  - grants are re-read LIVE per request (revocation bites immediately).
 */

import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { progressFor } from '../kicktodo-core/progressService.js';
import { todayFor, listCheckIns } from '../kicktodo-core/todayService.js';
import { getEnrollment } from '../kicktodo-core/enrollmentService.js';
import { CircleDeniedError, liveGrant, type AccountabilityCircle, type GrantScope } from './circleService.js';

const log = createLogger('kicktodo.projection');

export interface ProjectedFeed {
  circleId: string;
  /** Counts only — present under `progress-summary`. */
  summary?: {
    currentDay: number;
    durationDays: number;
    completedActivities: number;
    totalRequiredActivities: number;
    state: string;
  };
  /** Per-action completion — present under `action-status`. Titles are
   *  published challenge content (already public); NO instructions, NO notes. */
  actions?: Array<{ title: string; completed: boolean; note?: string }>;
}

/** The pure allowlist mapper (unit-testable; no I/O). */
export function projectFields(
  scopes: readonly GrantScope[],
  progress: { currentDay: number; durationDays: number; completedActivities: number; totalRequiredActivities: number; state: string },
  actions: Array<{ title: string; completed: boolean; note?: string }>,
): Omit<ProjectedFeed, 'circleId'> {
  const out: Omit<ProjectedFeed, 'circleId'> = {};
  if (scopes.includes('progress-summary')) {
    out.summary = {
      currentDay: progress.currentDay,
      durationDays: progress.durationDays,
      completedActivities: progress.completedActivities,
      totalRequiredActivities: progress.totalRequiredActivities,
      state: progress.state,
    };
  }
  if (scopes.includes('action-status')) {
    const withNotes = scopes.includes('check-in-note');
    out.actions = actions.map((a) => ({
      title: a.title,
      completed: a.completed,
      // Journal text ONLY under the explicit note scope — never implied.
      ...(withNotes && a.note !== undefined ? { note: a.note } : {}),
    }));
  }
  return out;
}

/** The circle feed: live grant → projection over the OWNING tenant's data. */
export async function circleFeedFor(circle: AccountabilityCircle, callerSubject: string): Promise<ProjectedFeed> {
  const grant = await liveGrant(circle.tenantId, circle.id, callerSubject);
  if (!grant) throw new CircleDeniedError();

  const enrollment = await getEnrollment(circle.tenantId, circle.enrollmentId);
  if (!enrollment) throw new CircleDeniedError();
  const progress = await progressFor(circle.tenantId, circle.enrollmentId);
  if (!progress) throw new CircleDeniedError();

  // Today's action rows for the PARTICIPANT (title + completion), joined with
  // note text only for the mapper to allowlist.
  const today = await todayFor(circle.tenantId, enrollment.ownerSubject);
  const mine = today.enrollments.find((e) => e.enrollmentId === circle.enrollmentId);
  const checkIns = await listCheckIns(circle.tenantId, circle.enrollmentId);
  const noteByCard = new Map(checkIns.map((c) => [c.cardId, c.note]));
  const actions = (mine?.actions ?? []).map((a) => ({
    title: a.card?.title ?? a.occurrence.stableActivityId,
    completed: a.card?.completed ?? false,
    ...(noteByCard.get(a.occurrence.cardId) !== undefined ? { note: noteByCard.get(a.occurrence.cardId) } : {}),
  }));

  return { circleId: circle.id, ...projectFields(grant.scopes, progress, actions) };
}

/** A nudge: a grantee with the `message` scope pokes the participant through
 *  the centralized notification owner (policy/quiet-hours enforced there).
 *  Content-free beyond the circle name — no progress data rides a nudge. */
export async function nudgeParticipant(circle: AccountabilityCircle, callerSubject: string): Promise<void> {
  const grant = await liveGrant(circle.tenantId, circle.id, callerSubject);
  if (!grant || !grant.scopes.includes('message')) throw new CircleDeniedError();
  const enrollment = await getEnrollment(circle.tenantId, circle.enrollmentId);
  if (!enrollment) throw new CircleDeniedError();
  try {
    await getNotificationEmitter().emit({
      tenantId: circle.tenantId,
      recipientUserId: enrollment.ownerSubject,
      type: 'task.assigned',
      priority: 'normal',
      title: 'A nudge from your circle',
      message: `Someone in "${circle.name}" is cheering you on today.`,
      actionUrl: '/kicktodo/today',
      metadata: { circleId: circle.id },
    });
  } catch (err) {
    // Notification backend absent (tests/minimal boots) — a nudge is
    // best-effort by definition.
    log.warn('kicktodo_nudge_emit_failed', { circleId: circle.id, error: err instanceof Error ? err.message : String(err) });
  }
}
