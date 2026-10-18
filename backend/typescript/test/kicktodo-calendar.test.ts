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
 *
 * w41 grade-tests: every case now owns its tenant, enrollment, consents and
 * transport (the old file shared ONE enrollment, so the owner-isolation case
 * only reached the owner check when an earlier case had left a transport
 * registered — the no-transport refusal throws the SAME CalendarUnavailableError).
 * `Date` is faked to a fixed noon so "today" cannot straddle midnight.
 *
 * Sabotages that turn this red (w41 probes): the consent check, the owner check
 * in syncEnrollmentCalendar and in remindToday, the supersession ledger match,
 * `isCalendarTransportConfigured`, routeReminder's consent + mute checks, the
 * snooze (`state !== 'active'`) check, and remindToday's routeReminder call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setNotificationBackend, getNotificationEmitter } from '../src/notifications/emitter.js';
import { setNotificationMuteResolver } from '../src/host/notificationPolicy.js';
import type { NotificationRecord } from '../src/types.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import {
  enroll, getEnrollment, reminderJobId, setSchedulePreference, __clearEnrollGuards, __test as coreStore,
} from '../src/features/kicktodo-core/enrollmentService.js';
import { setEnrollmentSnooze } from '../src/features/kicktodo-core/progressService.js';
import { submitCheckIn, journalFor } from '../src/features/kicktodo-core/todayService.js';
import { grantConsent, ConsentRequiredError } from '../src/features/kicktodo-integrations/integrationService.js';
import { buildKicktodoIntegrationsSurface } from '../src/features/kicktodo-integrations/surface.js';
import {
  registerCalendarTransport,
  __clearCalendarTransport,
  isCalendarTransportConfigured,
  syncEnrollmentCalendar,
  calendarEventId,
  routeReminder,
  CalendarUnavailableError,
  type CalendarTransport,
} from '../src/features/kicktodo-integrations/calendarWriteService.js';

const OWNER = 'user:cal-owner';
const INTRUDER = 'user:cal-intruder';
const TODAY = '2026-07-20';

let caseNo = 0;
let T = '';
let enrollmentId = '';

/** A recording in-memory transport (the connection-backed one is proven in
 *  kicktodo-calendar-provider-adapter.test.ts). */
function recordingTransport(): { transport: CalendarTransport; events: Map<string, { dateLocal: string; title: string }>; calls: string[] } {
  const events = new Map<string, { dateLocal: string; title: string }>();
  const calls: string[] = [];
  return {
    events,
    calls,
    transport: {
      upsert: async (id, ev, ctx) => { calls.push(`upsert:${ctx.ownerSubject}`); events.set(id, ev); },
      remove: async (id, ctx) => { calls.push(`remove:${ctx.ownerSubject}`); events.delete(id); },
    },
  };
}

function captureReminders(): { captured: NotificationRecord[]; unsub: () => void } {
  const captured: NotificationRecord[] = [];
  const unsub = getNotificationEmitter().subscribe((n) => {
    const meta: Record<string, unknown> | undefined = n.metadata;
    if (meta?.category === 'kicktodo-reminder') captured.push(n);
  });
  return { captured, unsub };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T12:00:00.000Z`) });
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setNotificationBackend(storage);
  setNotificationMuteResolver(async () => false);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCalendarTransport();
  caseNo += 1;
  T = `tenant-calendar-${caseNo}`;
  const draft = await createDraft({
    tenantId: T, title: 'Calendar Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'run', day: 1, title: 'Morning run', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  enrollmentId = enrollment.id;
});
afterEach(() => {
  __clearCalendarTransport();
  setNotificationMuteResolver(async () => false);
  vi.useRealTimers();
});

describe('isCalendarTransportConfigured (ADR 0438 A6 / B20 honest state)', () => {
  it('reflects the REAL transport state — false when absent, true when wired, false after clear', () => {
    expect(isCalendarTransportConfigured()).toBe(false); // honest default — no production transport
    registerCalendarTransport(recordingTransport().transport);
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

    const { transport, events } = recordingTransport();
    registerCalendarTransport(transport);

    const first = await syncEnrollmentCalendar(T, OWNER, enrollmentId);
    expect(first).toEqual({ upserted: 1, removed: 0 });
    const externalId = calendarEventId(enrollmentId, TODAY, 'run');
    expect([...events.keys()]).toEqual([externalId]);
    expect(events.get(externalId)).toEqual({ dateLocal: TODAY, title: 'KickTodo day 1: Morning run' });

    // Re-fired sync (replay) UPDATES the same event — never a duplicate.
    const again = await syncEnrollmentCalendar(T, OWNER, enrollmentId);
    expect(again.upserted).toBe(1);
    expect([...events.keys()]).toEqual([externalId]);

    // Supersede the occurrence (a plan revision withdrew it) → the external
    // event is deleted on the next sync.
    const occs = await coreStore.occurrences.listByPrefix(`${T}::${enrollmentId}::`);
    const target = occs.find((o) => o.stableActivityId === 'run');
    if (!target) throw new Error('the enrollment must have materialized today');
    await coreStore.occurrences.put({ ...target, supersededByRevision: target.planRevision + 1 });
    const after = await syncEnrollmentCalendar(T, OWNER, enrollmentId);
    expect(after.removed).toBe(1);
    expect(events.has(externalId)).toBe(false);
  });

  it('an owner cannot sync someone else’s enrollment (uniform failure)', async () => {
    // Both parties consented and a transport IS registered, so the refusal can
    // only come from the ownership check (not the consent or no-transport ones,
    // which throw the same error class).
    await grantConsent(T, OWNER, 'calendar-write');
    await grantConsent(T, INTRUDER, 'calendar-write');
    const { transport, calls } = recordingTransport();
    registerCalendarTransport(transport);

    await expect(syncEnrollmentCalendar(T, INTRUDER, enrollmentId)).rejects.toBeInstanceOf(CalendarUnavailableError);
    expect(calls).toEqual([]);

    // Positive control: the owner, through the same transport, writes.
    expect((await syncEnrollmentCalendar(T, OWNER, enrollmentId)).upserted).toBe(1);
    expect(calls).toEqual([`upsert:${OWNER}`]);
  });
});

describe('messaging reminder routing (P4)', () => {
  it('routes only under live consent, channel-tagged for the whatsapp owner', async () => {
    const { captured, unsub } = captureReminders();
    try {
      // No consent → no routing, no emit.
      expect(await routeReminder(T, OWNER, 'Morning run')).toBe(false);
      expect(captured).toHaveLength(0);

      await grantConsent(T, OWNER, 'messaging-reminders');
      expect(await routeReminder(T, OWNER, 'Morning run')).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.recipientUserId).toBe(OWNER);
      expect(captured[0]!.metadata).toMatchObject({ channel: 'whatsapp', category: 'kicktodo-reminder' });
      expect(captured[0]!.message).toBe('Morning run');
    } finally {
      unsub();
    }
  });

  it('ADR 0457 — a reminder respects the recipient app-level mute / quiet-hours (skipped, no emit)', async () => {
    const { captured, unsub } = captureReminders();
    try {
      await grantConsent(T, OWNER, 'messaging-reminders'); // consented…
      // …but the user muted this notification type (quiet-hours / per-type mute).
      setNotificationMuteResolver(async (_t, uid, ctx) => uid === OWNER && ctx.type === 'task.assigned');
      expect(await routeReminder(T, OWNER, 'Muted run')).toBe(false); // suppressed
      expect(captured).toHaveLength(0); // no in-app notification, no fan-out
    } finally {
      setNotificationMuteResolver(async () => false); // restore deliver-all
      unsub();
    }
  });
});

// ── ADR 0443 R1 — daypart preference + reminder-loop op ──
describe('schedule preference + remindToday (ADR 0443 R1)', () => {
  const scope: BundleScope = { tenantId: '' };
  const surface = () => buildKicktodoIntegrationsSurface({ ...scope, tenantId: T });

  it('owner sets/clears the daypart; wrong owner refused; job id deterministic', async () => {
    expect(reminderJobId(T, enrollmentId)).toBe(`kicktodo:${T}:${enrollmentId}:reminder`);
    expect(await setSchedulePreference(T, enrollmentId, 'user:not-owner', 'evening')).toBeNull();
    const set = await setSchedulePreference(T, enrollmentId, OWNER, 'evening');
    expect(set?.schedulePreference?.daypart).toBe('evening');
    const cleared = await setSchedulePreference(T, enrollmentId, OWNER, null);
    expect(cleared?.schedulePreference).toBeUndefined();
    expect((await getEnrollment(T, enrollmentId))?.schedulePreference).toBeUndefined();
  });

  it('remindToday: routes the pending headline under consent; honest skips otherwise', async () => {
    const s = surface();
    const { captured, unsub } = captureReminders();
    try {
      // wrong owner → not-found (uniform, no existence leak)
      expect(await s.remindToday!({ enrollmentId, ownerSubject: 'user:not-owner' }))
        .toEqual({ reminded: false, reason: 'not-found' });
      // a pending action but NO messaging consent → honest no-consent, nothing sent
      expect(await s.remindToday!({ enrollmentId, ownerSubject: OWNER }))
        .toEqual({ reminded: false, reason: 'no-consent' });
      expect(captured).toHaveLength(0);
      // consent → the pending headline (today's action title) is routed
      await grantConsent(T, OWNER, 'messaging-reminders');
      expect(await s.remindToday!({ enrollmentId, ownerSubject: OWNER })).toEqual({ reminded: true });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.recipientUserId).toBe(OWNER);
      expect(captured[0]!.message).toBe('Day 1: Morning run'); // today's card title
    } finally {
      unsub();
    }
  });

  it('a snoozed enrollment never reminds (deck slide 14 — snooze pauses reminders)', async () => {
    // Consented + a pending action: only the snooze can stop this reminder.
    await grantConsent(T, OWNER, 'messaging-reminders');
    await setEnrollmentSnooze(T, enrollmentId, OWNER, true);
    const { captured, unsub } = captureReminders();
    try {
      expect(await surface().remindToday!({ enrollmentId, ownerSubject: OWNER }))
        .toEqual({ reminded: false, reason: 'not-active' });
      expect(captured).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});

describe('journal (ADR 0443 R5)', () => {
  it('returns the caller’s OWN evidence-bearing check-ins newest-first; empty for others', async () => {
    const occs = await coreStore.occurrences.listByPrefix(`${T}::${enrollmentId}::`);
    const target = occs.find((o) => o.stableActivityId === 'run');
    if (!target) throw new Error('the enrollment must have materialized today');
    await submitCheckIn(T, OWNER, target.cardId, { note: 'felt great today' });
    const mine = await journalFor(T, OWNER);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.note).toBe('felt great today');
    expect(mine[0]!.enrollmentId).toBe(enrollmentId);
    // another subject sees NOTHING of it (self-data only)
    expect(await journalFor(T, INTRUDER)).toEqual([]);
  });
});
