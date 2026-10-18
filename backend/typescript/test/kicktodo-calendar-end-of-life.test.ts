/**
 * KTINT-1 + KTENR-4 (KickTodo wave 4C) — what an enrollment leaves behind when
 * it ends.
 *
 * KTINT-1: abandon, a `calendar-write` consent revoke and a DSAR all left the
 * events this lane had written on the participant's OWN calendar, and the ledger
 * rows that name them here. Each now removes them through the transport's
 * `remove` (a DSAR via the `onEnrollmentDeleted` signal, which carries the
 * deleted row's owner so the transport can reach that participant's calendar).
 *
 * KTENR-4: abandon left the opt-in reminder job and the calendar-sync job armed
 * (the nodes skipped the closed enrollment, so each fired a run a day for
 * nothing); erasure left every job armed forever with the owner's subject in its
 * inputs. Abandon now DISABLES them; erasure DELETES the two KickTodo-owned jobs
 * and disables the goal's daily loop (the goals owner keeps that job's lifecycle).
 *
 * What breaks these (sabotage-witnessed, each reverted and restored):
 *  - drop the `onEnrollmentAbandoned` / `onEnrollmentDeleted` / `onConsentRevoked`
 *    registrations in calendarWriteService → the event stays on the calendar;
 *  - drop the `fireEnrollmentAbandoned` call in `abandonEnrollment` → abandon cases red;
 *  - drop the reminder `setJobEnabled` in `abandonEnrollment`, or the `deleteJob`s
 *    in `deleteEnrollmentRow` / calendarSyncService → the job assertions red;
 *  - drop `ownerSubject` from the delete event → the DSAR case leaves the event
 *    (the transport cannot be reached without the owner).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getJob, resetScheduling } from '../src/host/schedulingService.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { continuationJobId } from '../src/features/goals/goalsService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import {
  abandonEnrollment, enroll, eraseSubjectEnrollments, reminderJobId, setSchedulePreference, __clearEnrollGuards,
} from '../src/features/kicktodo-core/enrollmentService.js';
import { grantConsent, revokeConsent } from '../src/features/kicktodo-integrations/integrationService.js';
import {
  registerCalendarTransport, __clearCalendarTransport, syncEnrollmentCalendar, calendarEventId, type CalendarTransport,
} from '../src/features/kicktodo-integrations/calendarWriteService.js';
import { calendarSyncJobId, setCalendarSyncEnabled } from '../src/features/kicktodo-integrations/calendarSyncService.js';

const OWNER = 'user:eol-cal-owner';
const TODAY = '2026-07-20';
const ledger = () => new DurableCollection<{ tenantId: string; enrollmentId: string; externalId: string; planRevision: number }>(
  'kicktodo-calendar-events', (w) => `${w.tenantId}::${w.enrollmentId}::${w.externalId}`);

let caseNo = 0;
let T = '';
let enrollmentId = '';
let goalId = '';
let events: Map<string, unknown>;
let failRemove = false;

const transport = (): CalendarTransport => ({
  upsert: async (id, ev) => { events.set(id, ev); },
  remove: async (id) => { if (failRemove) throw new Error('calendar down'); events.delete(id); },
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T12:00:00.000Z`) });
  initHostExtPersistence(await openStorage('memory://'));
  await resetScheduling();
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  events = new Map();
  failRemove = false;
  registerCalendarTransport(transport());
  caseNo += 1;
  T = `tenant-cal-eol-${caseNo}`;
  const draft = await createDraft({
    tenantId: T, title: 'Calendar EOL', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'run', day: 1, title: 'Morning run', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  enrollmentId = enrollment.id;
  goalId = enrollment.goalId;
  await grantConsent(T, OWNER, 'calendar-write');
  await syncEnrollmentCalendar(T, OWNER, enrollmentId);
  await setSchedulePreference(T, enrollmentId, OWNER, 'morning');
  await setCalendarSyncEnabled(T, enrollmentId, OWNER, true);
});
afterEach(() => {
  __clearCalendarTransport();
  vi.useRealTimers();
});

const externalId = () => calendarEventId(enrollmentId, TODAY, 'run');
const ledgerRows = async () => ledger().listByPrefix(`${T}::${enrollmentId}::`);

describe('KTINT-1 — written calendar events are removed when the enrollment ends', () => {
  it('precondition: the sync wrote one event and one ledger row; the jobs are armed', async () => {
    expect([...events.keys()]).toEqual([externalId()]);
    expect(await ledgerRows()).toHaveLength(1);
    expect((await getJob(reminderJobId(T, enrollmentId)))?.enabled).toBe(true);
    expect((await getJob(calendarSyncJobId(T, enrollmentId)))?.enabled).toBe(true);
  });

  it('abandon removes the event + ledger row and DISABLES the reminder and sync jobs (KTENR-4)', async () => {
    await abandonEnrollment(T, enrollmentId, OWNER);
    expect(events.size).toBe(0);
    expect(await ledgerRows()).toEqual([]);
    expect((await getJob(reminderJobId(T, enrollmentId)))?.enabled).toBe(false);
    expect((await getJob(calendarSyncJobId(T, enrollmentId)))?.enabled).toBe(false);
  });

  it('a failed remove on abandon KEEPS the ledger row so a later call can retry', async () => {
    failRemove = true;
    await abandonEnrollment(T, enrollmentId, OWNER);
    expect(events.size).toBe(1);
    expect(await ledgerRows()).toHaveLength(1);
  });

  it('revoking calendar-write consent removes the events it authorised', async () => {
    await revokeConsent(T, OWNER, 'calendar-write');
    expect(events.size).toBe(0);
    expect(await ledgerRows()).toEqual([]);
  });

  it('revoking an UNRELATED consent removes nothing', async () => {
    await grantConsent(T, OWNER, 'messaging-reminders');
    await revokeConsent(T, OWNER, 'messaging-reminders');
    expect(events.size).toBe(1);
  });

  it('DSAR erasure removes the event, drops the ledger, DELETES the KickTodo jobs and disables the daily loop (KTENR-4)', async () => {
    expect((await getJob(continuationJobId(T, goalId)))?.enabled).toBe(true);
    await eraseSubjectEnrollments(T, OWNER);
    expect(events.size).toBe(0);
    expect(await ledgerRows()).toEqual([]);
    expect(await getJob(reminderJobId(T, enrollmentId))).toBeNull();
    expect(await getJob(calendarSyncJobId(T, enrollmentId))).toBeNull();
    expect((await getJob(continuationJobId(T, goalId)))?.enabled).toBe(false);
  });

  it('a failed remove on DSAR still drops the ledger row (nothing could ever retry it)', async () => {
    failRemove = true;
    await eraseSubjectEnrollments(T, OWNER);
    expect(await ledgerRows()).toEqual([]);
  });
});
