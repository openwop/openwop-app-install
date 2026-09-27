/**
 * Calendar WRITE lane + messaging routing (ADR 0421 P2/P4).
 *
 * P2 — REPLAY-SAFE external writes: every event carries the deterministic
 * external id `(enrollmentId|dateLocal|activityId)` — a re-fired sync UPSERTS
 * (never duplicates), and a plan-revision supersession DELETES the stale
 * event (the ADR 0414 cascade, extended outward). The TRANSPORT is a
 * registered port: production registers a connection-backed transport (the
 * RFC 0095 calendar-pack seam, egress-guarded there); absent transport fails
 * closed as host_capability_missing. An LLM/workflow never holds credentials.
 *
 * P4 — messaging reminders: a consented channel preference; delivery rides
 * the CENTRALIZED notification owner with the channel tagged in metadata —
 * the whatsapp owner (ADR 0394) consumes its category downstream. Policy,
 * quiet hours, and opt-in stay with those owners.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { isNotificationMuted } from '../../host/notificationPolicy.js';
import { registerPlanRevisedListener } from '../../host/planRevisedHook.js';
import { getEnrollment, occurrencesOn, __test as coreStore } from '../kicktodo-core/enrollmentService.js';
import { getChallenge } from '../kicktodo-core/challengeService.js';
import { localDateIn } from '../kicktodo-core/types.js';
import { liveConsent, ConsentRequiredError } from './integrationService.js';

const log = createLogger('kicktodo.calendar');

/** ADR 0462 / KT-PORT-6a — the owning participant a write is for. A
 *  connection-backed transport needs it to resolve THAT subject's calendar
 *  Connection credential (calendar-write is per-participant, never tenant-wide). */
export interface CalendarWriteContext {
  tenantId: string;
  ownerSubject: string;
}

export interface CalendarTransport {
  upsert(externalId: string, event: { dateLocal: string; title: string }, ctx: CalendarWriteContext): Promise<void>;
  remove(externalId: string, ctx: CalendarWriteContext): Promise<void>;
}

let transport: CalendarTransport | null = null;

/** Production registers the connection-backed transport at boot (RFC 0095
 *  calendar pack); tests register fakes. */
export function registerCalendarTransport(t: CalendarTransport): void {
  transport = t;
}
export function __clearCalendarTransport(): void {
  transport = null;
}

/** Whether a production calendar-write transport is registered in THIS deployment
 *  (ADR 0438 A6 / B20). A deployment-global fact — the honest source for the admin
 *  console's "port awaiting adapter" vs "connected" render (never hardcoded). */
export function isCalendarTransportConfigured(): boolean {
  return transport !== null;
}

/** Written-event ledger — what supersession must clean up. */
const written = new DurableCollection<{ tenantId: string; enrollmentId: string; externalId: string; planRevision: number }>(
  'kicktodo-calendar-events',
  (w) => `${w.tenantId}::${w.enrollmentId}::${w.externalId}`,
);

// ADR 0458 P0 — this ledger carries NO personal data: it is the operational (`internal`)
// bookkeeping of deterministic external calendar-event ids per enrollment, existing only so
// a supersession/re-sync can UPSERT/DELETE the right external events (no name, note, or
// subject key). It is therefore neither on the subject-erasure seam nor the retention sweep;
// the personal integration data (consents/feeds/wearable rules) is erased in
// integrationService's `eraseIntegrationsSubject`.

export function calendarEventId(enrollmentId: string, dateLocal: string, stableActivityId: string): string {
  return `${enrollmentId}|${dateLocal}|${stableActivityId}`;
}

export class CalendarUnavailableError extends Error {
  constructor() {
    super('No calendar transport is configured — connect a calendar first.');
  }
}

/**
 * Sync today's live occurrences to the connected calendar (consent-gated,
 * idempotent) and delete events whose occurrences a plan revision superseded.
 */
export async function syncEnrollmentCalendar(
  tenantId: string,
  ownerSubject: string,
  enrollmentId: string,
): Promise<{ upserted: number; removed: number }> {
  if (!(await liveConsent(tenantId, ownerSubject, 'calendar-write'))) throw new ConsentRequiredError('calendar-write');
  if (!transport) throw new CalendarUnavailableError();
  const e = await getEnrollment(tenantId, enrollmentId);
  if (!e || e.ownerSubject !== ownerSubject) throw new CalendarUnavailableError();
  const challenge = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
  const date = localDateIn(e.timezone);

  let upserted = 0;
  let removed = 0;

  // Live occurrences → deterministic upserts (a re-sync updates, never dupes).
  const live = await occurrencesOn(tenantId, enrollmentId, date);
  for (const occ of live) {
    const activity = challenge?.activities.find((a) => a.stableActivityId === occ.stableActivityId);
    const externalId = calendarEventId(enrollmentId, occ.occurrenceDateLocal, occ.stableActivityId);
    await transport.upsert(externalId, {
      dateLocal: occ.occurrenceDateLocal,
      title: `KickTodo day ${activity?.day ?? ''}: ${activity?.title ?? occ.stableActivityId}`,
    }, { tenantId, ownerSubject });
    await written.put({ tenantId, enrollmentId, externalId, planRevision: occ.planRevision });
    upserted += 1;
  }

  // Superseded occurrences whose events were written → remove (the outward
  // half of the ADR 0414 plan-revision cascade).
  const allOccs = await coreStore.occurrences.listByPrefix(`${tenantId}::${enrollmentId}::`);
  for (const occ of allOccs) {
    if (occ.supersededByRevision === undefined) continue;
    const externalId = calendarEventId(enrollmentId, occ.occurrenceDateLocal, occ.stableActivityId);
    const row = await written.get(`${tenantId}::${enrollmentId}::${externalId}`);
    if (!row || row.planRevision !== occ.planRevision) continue;
    await transport.remove(externalId, { tenantId, ownerSubject });
    await written.delete(`${tenantId}::${enrollmentId}::${externalId}`);
    removed += 1;
  }

  log.info('kicktodo_calendar_synced', { enrollmentId, upserted, removed });
  return { upserted, removed };
}

/** P4 — route a reminder through the centralized notification owner with the
 *  consented channel tagged; the whatsapp owner consumes its category
 *  downstream (channel-delivery windows stay there). Content-free beyond
 *  the action title. */
export async function routeReminder(tenantId: string, ownerSubject: string, title: string): Promise<boolean> {
  const consent = await liveConsent(tenantId, ownerSubject, 'messaging-reminders');
  if (!consent) return false; // no consent — silently no channel routing
  // ADR 0457 — respect the recipient's APP-LEVEL notification mute / quiet-hours
  // before emitting. The emitter does not auto-consult it; producers must (the
  // channelActivityNotify precedent), else a muted user still gets the in-app
  // notification + web-push fan-out. A routine reminder is 'normal' priority, so
  // quiet-hours suppresses it; fail-open (no resolver ⇒ delivers, unchanged).
  if (await isNotificationMuted(tenantId, ownerSubject, { type: 'task.assigned', priority: 'normal' })) return false;
  try {
    await getNotificationEmitter().emit({
      tenantId,
      recipientUserId: ownerSubject,
      type: 'task.assigned',
      priority: 'normal',
      title: 'KickTodo reminder',
      message: title,
      actionUrl: '/kicktodo/today',
      metadata: { channel: 'whatsapp', category: 'kicktodo-reminder' },
    });
    return true;
  } catch (err) {
    log.warn('kicktodo_reminder_emit_failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ── ENG-15(b) — project a plan revision onto the participant's calendar ──────
//
// Registered at module load (the host-seam house pattern). kicktodo-core announces
// a durable revision via `emitPlanRevised` and does NOT know we exist, so there is
// no `core → integrations` edge — the direction that took the ADR 0446 classifier's
// `[3] Hard-dep` count from 0 to 1 and was reverted for it. The reverse direction
// (integrations → core) already exists above and is fine.
//
// Gated on a MOVE having landed: only a move changes the DATES a calendar shows, so
// a daypart-preference revision must not become an external write.
//
// No try/catch here on purpose — `emitPlanRevised` contains listener errors by
// contract, so duplicating the guard would just hide which layer owns fail-soft.
// `syncEnrollmentCalendar` still throws ConsentRequiredError / CalendarUnavailableError
// for a participant who has not connected a calendar; that is the expected path and
// the host seam logs it at info.
registerPlanRevisedListener(async (ev) => {
  if (!ev.lanes.includes('move')) return;
  const out = await syncEnrollmentCalendar(ev.tenantId, ev.ownerSubject, ev.enrollmentId);
  log.info('kicktodo_move_calendar_synced', { enrollmentId: ev.enrollmentId, ...out });
});
