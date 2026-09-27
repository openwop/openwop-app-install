/**
 * Cohort sessions (ADR 0444 S1/S2) — the deck slide-8 coach ritual: a scheduled
 * moment on the circle's EXISTING conversation (the ONE chat — circles already
 * own a deterministic conversation; this adds a WHEN, never a second chat).
 *
 * Composition only: the coach = the circle owner; membership = the circle's
 * live grants (the ADR 0419 consent truth — seat purchase flows into a grant);
 * the session row binds {circle → when} with the circle's conversationId
 * denormalized for the client's one-tap join. Deterministic key
 * `${tenant}::${circleId}::${atIso}` ⇒ idempotent scheduling.
 *
 * S2 (this slice): scheduling notifies every live grantee through the ONE
 * notification seam — content-minimal. The KickBot co-host binding via
 * scheduled-agent-chats is DEFERRED: that seam requires an org- or
 * channel-scoped conversation (ADR 0202 D3) and the circle's is a private
 * group — recorded in ADR 0444 rather than force-fit.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { isNotificationMuted } from '../../host/notificationPolicy.js';
import { registerJob, setJobEnabled, ONE_SHOT_CRON } from '../../host/schedulingService.js';
import { getCircleFor, listGrantsInternal } from './circleService.js';

const log = createLogger('kicktodo.sessions');

/** ADR 0458 Phase 0 — how far before the session the reminder fires. */
const SESSION_REMINDER_LEAD_MS = 60 * 60 * 1000;

/** ADR 0459 P3 — the builtin the armed T-minus reminder job fires (delivery node). */
export const SESSION_REMINDER_WORKFLOW_ID = 'openwop-app.kicktodo.session-reminder';

/** Deterministic reminder-job id for a scheduled session (tenant-scoped — the
 *  ADR 0379 cross-tenant overwrite guard keys on this; distinct from the enrollment
 *  reminder id so neither cadence overwrites the other). */
export function sessionReminderJobId(tenantId: string, circleId: string, atIso: string): string {
  return `kicktodo:${tenantId}:session:${circleId}:${atIso}:reminder`;
}

export interface CohortSession {
  tenantId: string;
  circleId: string;
  /** The scheduled moment (ISO instant, minute precision enforced at parse). */
  atIso: string;
  title: string;
  createdBy: string;
  /** The circle's OWN conversation — the session happens there (one chat). */
  conversationId: string;
  createdAt: string;
  cancelledAt?: string;
}

const sessions = new DurableCollection<CohortSession>(
  'kicktodo-cohort-sessions',
  (s) => `${s.tenantId}::${s.circleId}::${s.atIso}`,
);

const nowIso = (): string => new Date().toISOString();

export class SessionDeniedError extends Error {
  constructor() { super('Not found.'); } // uniform — no existence leak
}
export class SessionTimeError extends Error {
  constructor() { super('`at` must be a future ISO instant.'); }
}

/** Schedule (idempotently) a session on the coach's circle. Coach = circle
 *  owner; a grantee cannot schedule. Notifies every live grantee (S2). */
export async function scheduleSession(
  tenantId: string,
  circleId: string,
  actor: string,
  atIsoRaw: string,
  title: string,
): Promise<CohortSession> {
  const circle = await getCircleFor(tenantId, circleId, actor).catch(() => null);
  if (!circle || circle.ownerSubject !== actor) throw new SessionDeniedError();
  const atMs = Date.parse(atIsoRaw);
  if (!Number.isFinite(atMs) || atMs <= Date.now()) throw new SessionTimeError();
  // MINUTE precision, enforced (grade-code): the key includes atIso, so two
  // schedules 500ms apart would otherwise mint two rows + two notify fan-outs.
  const atIso = new Date(Math.floor(atMs / 60_000) * 60_000).toISOString();

  const key = `${tenantId}::${circleId}::${atIso}`;
  const existing = await sessions.get(key);
  if (existing && !existing.cancelledAt) return existing; // idempotent re-schedule

  const row: CohortSession = {
    tenantId,
    circleId,
    atIso,
    title: title.trim() || 'Cohort session',
    createdBy: actor,
    conversationId: circle.conversationId,
    createdAt: nowIso(),
  };
  await sessions.put(row);

  // ADR 0458 Phase 0 — SCHEDULING DISCIPLINE: the T-minus reminder's fire-at time
  // is owned by the scheduling owner, NOT a poller looping over session rows. Arm a
  // ONE-SHOT scheduler job (deterministic id ⇒ an idempotent re-schedule upserts the
  // same job, never a second one) that fires ~1h before `atIso` (clamped to now for
  // a soon-starting session). The immediate notify below stays as the "scheduled"
  // CONFIRMATION. Attribution rides the coach (`ownerUserId`), not KickBot: the
  // KickBot co-host binding is DEFERRED (module header) because a circle's
  // conversation is a private group. NOTE (follow-up): the reminder DELIVERY node is
  // a `feature.kicktodo.nodes` pack slice (pins frozen at 1.13.0 this phase); the job
  // carries the full context in `inputs`/`metadata` so wiring the node later needs no
  // reschedule. Best-effort — a scheduler hiccup never fails the schedule.
  try {
    const res = await registerJob({
      jobId: sessionReminderJobId(tenantId, circleId, atIso),
      tenantId,
      cronExpr: ONE_SHOT_CRON,
      firstFireAtMs: Math.max(atMs - SESSION_REMINDER_LEAD_MS, Date.now()),
      enabled: true,
      ownerUserId: actor,
      // ADR 0459 P3 — the DELIVERY node. The job carried the full context in
      // `inputs` since ADR 0458 Phase 0 but had no `workflowId`, so the scheduler
      // filtered it out (it fired into nothing — KT-PORT-3). Stamping the builtin
      // wires the delivery: the daemon starts `session-reminder` seeding these
      // inputs as its variables; no reschedule needed.
      workflowId: SESSION_REMINDER_WORKFLOW_ID,
      inputs: { circleId, atIso, conversationId: circle.conversationId },
      metadata: { purpose: 'kicktodo-session-reminder', circleId, atIso },
    });
    if (!res.ok) log.warn('kicktodo_session_reminder_job_failed', { circleId, atIso, error: res.error.message });
  } catch (err) {
    log.warn('kicktodo_session_reminder_arm_failed', { circleId, atIso, error: err instanceof Error ? err.message : String(err) });
  }

  // S2 — tell every LIVE grantee (content-minimal; the join is the circle chat
  // they already consented into). Best-effort: a notify hiccup never fails the
  // schedule.
  try {
    const grants = await listGrantsInternal(tenantId, circleId);
    const emitter = getNotificationEmitter();
    for (const g of grants) {
      if (g.state !== 'active' || g.granteeSubject === actor) continue;
      await emitter.emit({
        tenantId,
        recipientUserId: g.granteeSubject,
        type: 'task.assigned',
        priority: 'normal',
        title: 'Cohort session scheduled',
        message: `“${row.title}” — ${atIso}`,
        actionUrl: `/kicktodo/circles`,
        metadata: { category: 'kicktodo-session', circleId },
      });
    }
  } catch (err) {
    log.warn('kicktodo_session_notify_failed', { circleId, error: err instanceof Error ? err.message : String(err) });
  }
  log.info('kicktodo_session_scheduled', { circleId, atIso });
  return row;
}

/** Cancel a scheduled session (coach only; idempotent; row kept for history). */
export async function cancelSession(tenantId: string, circleId: string, actor: string, atIso: string): Promise<void> {
  const circle = await getCircleFor(tenantId, circleId, actor).catch(() => null);
  if (!circle || circle.ownerSubject !== actor) throw new SessionDeniedError();
  const row = await sessions.get(`${tenantId}::${circleId}::${atIso}`);
  if (row && !row.cancelledAt) await sessions.put({ ...row, cancelledAt: nowIso() });
  // ADR 0458 Phase 0 — disarm the T-minus reminder the scheduling owner holds
  // (no-op when never armed / already spent). Best-effort; the row stays for history.
  await setJobEnabled(sessionReminderJobId(tenantId, circleId, atIso), false).catch(() => undefined);
}

/**
 * ADR 0459 P3 — deliver a scheduled session's T-minus reminder to the circle's live
 * grantees. Called by the `feature.kicktodo.nodes.session-reminder` pack node when
 * the one-shot scheduler job fires (~1h before the session). The delivery, the
 * live-grantee fan-out, and the ADR 0457 mute-respect all live HERE (the node is a
 * thin adapter). Per-recipient: skip the coach (`createdBy` — the session's own
 * host), skip non-active grants, and skip a muted recipient (mute keyed on the
 * circle's conversation) BEFORE emitting. A cancelled/absent session is an honest
 * no-op (`reason`), never a delivery. Best-effort per recipient — one emit failure
 * never drops the rest.
 */
export async function sendSessionReminder(
  tenantId: string,
  args: { circleId: string; atIso: string; conversationId?: string },
): Promise<{ notified: boolean; reason?: string }> {
  const { circleId, atIso } = args;
  if (!tenantId || !circleId || !atIso) return { notified: false, reason: 'missing-context' };
  const row = await sessions.get(`${tenantId}::${circleId}::${atIso}`);
  if (!row || row.cancelledAt) return { notified: false, reason: 'session-not-scheduled' };

  const grants = await listGrantsInternal(tenantId, circleId);
  const emitter = getNotificationEmitter();
  let notified = false;
  for (const g of grants) {
    if (g.state !== 'active' || g.granteeSubject === row.createdBy) continue; // skip the coach/host
    // ADR 0457 — mute-respect BEFORE emit (per recipient), keyed on the circle chat.
    if (await isNotificationMuted(tenantId, g.granteeSubject, { conversationId: row.conversationId, type: 'task.assigned', priority: 'normal' })) continue;
    try {
      await emitter.emit({
        tenantId,
        recipientUserId: g.granteeSubject,
        type: 'task.assigned',
        priority: 'normal',
        title: 'Cohort session starting soon',
        message: `“${row.title}” — ${atIso}`,
        actionUrl: `/kicktodo/circles`,
        metadata: { category: 'kicktodo-session-reminder', circleId },
      });
      notified = true;
    } catch (err) {
      log.warn('kicktodo_session_reminder_emit_failed', { circleId, grantee: g.granteeSubject, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return notified ? { notified: true } : { notified: false, reason: 'no-live-recipients' };
}

/** Upcoming (non-cancelled, future) sessions for a circle the CALLER belongs to.
 *  `getCircleFor` IS the owner-or-live-grantee membership truth (uniform denial). */
export async function listSessions(tenantId: string, circleId: string, caller: string): Promise<CohortSession[]> {
  const circle = await getCircleFor(tenantId, circleId, caller).catch(() => null);
  if (!circle) throw new SessionDeniedError();
  const rows = await sessions.listByPrefix(`${tenantId}::${circleId}::`);
  const now = Date.now();
  return rows
    .filter((s) => !s.cancelledAt && Date.parse(s.atIso) > now)
    .sort((a, b) => a.atIso.localeCompare(b.atIso));
}

// ── ADR 0458 Phase 0 — compliance (subject erasure) ──
/**
 * DSAR erasure: delete every session this subject CREATED (a session's `createdBy` is
 * the coach who scheduled it — their participation row) and disarm each session's
 * T-minus reminder job. Bounded tenant-prefix scan; idempotent; fail-closed on a
 * falsy tenant/subject. Returns the count removed.
 */
export async function eraseSubjectSessions(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  let removed = 0;
  for (const s of await sessions.listByPrefix(`${tenantId}::`)) {
    if (s.tenantId === tenantId && s.createdBy === subjectKey) {
      await setJobEnabled(sessionReminderJobId(tenantId, s.circleId, s.atIso), false).catch(() => undefined);
      if (await sessions.delete(`${s.tenantId}::${s.circleId}::${s.atIso}`)) removed += 1;
    }
  }
  return removed;
}
