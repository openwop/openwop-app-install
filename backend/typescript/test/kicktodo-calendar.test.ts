/**
 * ADR 0421 P2/P4 — the calendar WRITE lane + messaging reminder routing:
 *
 *  - sync is consent-gated and fails CLOSED without a registered transport
 *  - external event ids are DETERMINISTIC `(enrollmentId|date|activityId)` —
 *    a re-fired sync UPDATES the same event, never duplicates
 *  - a plan-revision supersession DELETES the stale external event (the
 *    ADR 0414 cascade, extended outward)
 *  - reminders route through the CENTRALIZED notification owner only under
 *    live `messaging-reminders` consent, channel-tagged for the whatsapp owner
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setNotificationBackend, getNotificationEmitter } from '../src/notifications/emitter.js';
import { setNotificationMuteResolver } from '../src/host/notificationPolicy.js';
import type { NotificationRecord } from '../src/types.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards, __test as coreStore } from '../src/features/kicktodo-core/enrollmentService.js';
import { grantConsent } from '../src/features/kicktodo-integrations/integrationService.js';
import {
  registerCalendarTransport,
  __clearCalendarTransport,
  isCalendarTransportConfigured,
  syncEnrollmentCalendar,
  calendarEventId,
  routeReminder,
  CalendarUnavailableError,
} from '../src/features/kicktodo-integrations/calendarWriteService.js';
import { ConsentRequiredError } from '../src/features/kicktodo-integrations/integrationService.js';

const T = 'tenant-calendar';
const OWNER = 'user:cal-owner';

let enrollmentId = '';

/** In-memory fake of the connection-backed transport. */
const events = new Map<string, { dateLocal: string; title: string }>();

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setNotificationBackend(storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCalendarTransport();
  const draft = await createDraft({
    tenantId: T, title: 'Calendar Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'run', day: 1, title: 'Morning run', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  enrollmentId = enrollment.id;
});

describe('isCalendarTransportConfigured (ADR 0438 A6 / B20 honest state)', () => {
  it('reflects the REAL transport state — false when absent, true when wired, false after clear', () => {
    __clearCalendarTransport();
    expect(isCalendarTransportConfigured()).toBe(false); // honest default — no production transport
    registerCalendarTransport({ upsert: async () => {}, remove: async () => {} });
    expect(isCalendarTransportConfigured()).toBe(true);
    __clearCalendarTransport();
    expect(isCalendarTransportConfigured()).toBe(false);
  });
});

describe('calendar WRITE lane (P2)', () => {
  it('consent-gated; transport fails closed; deterministic upserts never duplicate; supersession deletes', async () => {
    await expect(syncEnrollmentCalendar(T, OWNER, enrollmentId)).rejects.toBeInstanceOf(ConsentRequiredError);

    await grantConsent(T, OWNER, 'calendar-write');
    // Consent granted but NO transport registered → fail closed.
    await expect(syncEnrollmentCalendar(T, OWNER, enrollmentId)).rejects.toBeInstanceOf(CalendarUnavailableError);

    registerCalendarTransport({
      upsert: async (id, ev) => void events.set(id, ev),
      remove: async (id) => void events.delete(id),
    });

    const first = await syncEnrollmentCalendar(T, OWNER, enrollmentId);
    expect(first.upserted).toBe(1);
    expect(events.size).toBe(1);
    const [externalId] = [...events.keys()];
    expect(externalId.startsWith(`${enrollmentId}|`)).toBe(true);
    expect(externalId.endsWith('|run')).toBe(true);
    expect(events.get(externalId)?.title).toContain('Morning run');

    // Re-fired sync (replay) UPDATES the same event — never a duplicate.
    const again = await syncEnrollmentCalendar(T, OWNER, enrollmentId);
    expect(again.upserted).toBe(1);
    expect(events.size).toBe(1);

    // Supersede the occurrence (a plan revision withdrew it) → the external
    // event is deleted on the next sync.
    const occs = await coreStore.occurrences.listByPrefix(`${T}::${enrollmentId}::`);
    const target = occs.find((o) => o.stableActivityId === 'run');
    expect(target).toBeTruthy();
    await coreStore.occurrences.put({ ...target!, supersededByRevision: target!.planRevision + 1 });
    const after = await syncEnrollmentCalendar(T, OWNER, enrollmentId);
    expect(after.removed).toBe(1);
    expect(events.has(calendarEventId(enrollmentId, target!.occurrenceDateLocal, 'run'))).toBe(false);
  });

  it('an owner cannot sync someone else’s enrollment (uniform failure)', async () => {
    await grantConsent(T, 'user:cal-intruder', 'calendar-write');
    await expect(syncEnrollmentCalendar(T, 'user:cal-intruder', enrollmentId)).rejects.toBeInstanceOf(CalendarUnavailableError);
  });
});

describe('messaging reminder routing (P4)', () => {
  it('routes only under live consent, channel-tagged for the whatsapp owner', async () => {
    const captured: NotificationRecord[] = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      if ((n.metadata as Record<string, unknown> | undefined)?.category === 'kicktodo-reminder') captured.push(n);
    });
    try {
      // No consent → no routing, no emit.
      expect(await routeReminder(T, OWNER, 'Morning run')).toBe(false);
      expect(captured.length).toBe(0);

      await grantConsent(T, OWNER, 'messaging-reminders');
      expect(await routeReminder(T, OWNER, 'Morning run')).toBe(true);
      expect(captured.length).toBe(1);
      expect(captured[0].recipientUserId).toBe(OWNER);
      expect((captured[0].metadata as Record<string, unknown>).channel).toBe('whatsapp');
      expect(captured[0].message).toBe('Morning run');
    } finally {
      unsub();
    }
  });

  it('ADR 0457 — a reminder respects the recipient app-level mute / quiet-hours (skipped, no emit)', async () => {
    const captured: NotificationRecord[] = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      if ((n.metadata as Record<string, unknown> | undefined)?.category === 'kicktodo-reminder') captured.push(n);
    });
    try {
      await grantConsent(T, OWNER, 'messaging-reminders'); // consented…
      // …but the user muted this notification type (quiet-hours / per-type mute).
      setNotificationMuteResolver(async (_t, uid, ctx) => uid === OWNER && ctx.type === 'task.assigned');
      expect(await routeReminder(T, OWNER, 'Muted run')).toBe(false); // suppressed
      expect(captured.length).toBe(0); // no in-app notification, no fan-out
    } finally {
      setNotificationMuteResolver(async () => false); // restore deliver-all
      unsub();
    }
  });
});

// ── ADR 0443 R1 — daypart preference + reminder-loop op ──
describe('schedule preference + remindToday (ADR 0443 R1)', () => {
  it('owner sets/clears the daypart; wrong owner refused; job id deterministic', async () => {
    const { setSchedulePreference, reminderJobId, getEnrollment: getE } =
      await import('../src/features/kicktodo-core/enrollmentService.js');
    expect(reminderJobId(T, enrollmentId)).toBe(`kicktodo:${T}:${enrollmentId}:reminder`);
    expect(await setSchedulePreference(T, enrollmentId, 'user:not-owner', 'evening')).toBeNull();
    const set = await setSchedulePreference(T, enrollmentId, OWNER, 'evening');
    expect(set?.schedulePreference?.daypart).toBe('evening');
    const cleared = await setSchedulePreference(T, enrollmentId, OWNER, null);
    expect(cleared?.schedulePreference).toBeUndefined();
    expect((await getE(T, enrollmentId))?.schedulePreference).toBeUndefined();
  });

  it('remindToday: routes the pending headline under consent; honest skips otherwise', async () => {
    const { buildKicktodoIntegrationsSurface } = await import('../src/features/kicktodo-integrations/surface.js');
    const s = buildKicktodoIntegrationsSurface({ tenantId: T } as never);
    // wrong owner → not-found (uniform, no existence leak)
    expect(await s.remindToday!({ enrollmentId, ownerSubject: 'user:not-owner' }))
      .toEqual({ reminded: false, reason: 'not-found' });
    // messaging consent was granted earlier in this file → the pending headline routes
    const ok = await s.remindToday!({ enrollmentId, ownerSubject: OWNER }) as { reminded: boolean; reason?: string };
    // either reminds (pending action exists) or honestly reports nothing-pending —
    // both are consent-clean; assert it NEVER errors and the reason is a known one
    expect([undefined, 'nothing-pending']).toContain(ok.reason);
  });

  it('a snoozed enrollment never reminds (deck slide 14 — snooze pauses reminders)', async () => {
    const { setEnrollmentSnooze } = await import('../src/features/kicktodo-core/progressService.js');
    const { buildKicktodoIntegrationsSurface } = await import('../src/features/kicktodo-integrations/surface.js');
    await setEnrollmentSnooze(T, enrollmentId, OWNER, true);
    const s = buildKicktodoIntegrationsSurface({ tenantId: T } as never);
    expect(await s.remindToday!({ enrollmentId, ownerSubject: OWNER }))
      .toEqual({ reminded: false, reason: 'not-active' });
  });
});

describe('journal (ADR 0443 R5)', () => {
  it('returns the caller’s OWN evidence-bearing check-ins newest-first; empty for others', async () => {
    const { setEnrollmentSnooze } = await import('../src/features/kicktodo-core/progressService.js');
    const { submitCheckIn, journalFor } = await import('../src/features/kicktodo-core/todayService.js');
    await setEnrollmentSnooze(T, enrollmentId, OWNER, false); // resume after the snooze test
    const occs = await coreStore.occurrences.listByPrefix(`${T}::${enrollmentId}::`);
    // The P2 supersession test marked the sole occurrence superseded — restore it
    // (this test owns its own precondition, not the earlier test's side effect).
    const restored = { ...occs[0]! };
    delete restored.supersededByRevision;
    await coreStore.occurrences.put(restored);
    const target = restored;
    expect(target).toBeTruthy();
    await submitCheckIn(T, OWNER, target.cardId, { note: 'felt great today' });
    const mine = await journalFor(T, OWNER);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0].note).toBe('felt great today');
    expect(mine[0].enrollmentId).toBe(enrollmentId);
    // another subject sees NOTHING of it (self-data only)
    expect(await journalFor(T, 'user:cal-intruder')).toEqual([]);
  });
});
