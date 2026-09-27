/**
 * ADR 0459 P3 — the cohort-session T-minus reminder delivery lane, host half.
 *
 *  1. `scheduleSession` now arms the one-shot reminder job WITH a `workflowId`
 *     (KT-PORT-3 fix): the scheduler daemon fires the `session-reminder` builtin,
 *     seeding the { circleId, atIso, conversationId } the job already carried as the
 *     run's variables. Before the fix the job had no workflowId and fired into
 *     nothing (the daemon filters workflow-less jobs out).
 *  2. `sendSessionReminder` (the session-notify surface op the delivery node rides)
 *     notifies every LIVE grantee, SKIPS the coach, and respects each recipient's
 *     mute preference (ADR 0457) BEFORE emitting.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setNotificationBackend } from '../src/notifications/emitter.js';
import { setNotificationMuteResolver } from '../src/host/notificationPolicy.js';
import { resetScheduling } from '../src/host/schedulingService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { createCircle, inviteToCircle, acceptGrant } from '../src/features/kicktodo-accountability/circleService.js';
import { scheduleSession, sendSessionReminder, sessionReminderJobId, SESSION_REMINDER_WORKFLOW_ID } from '../src/features/kicktodo-accountability/sessionService.js';

// Fake catalog: fires a run for whatever workflowId the job carries (the daemon
// path we assert is the job → startWorkflowRun → inputs-seeded run wiring).
const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

const T = 'tenant-session-reminder';
const COACH = 'user:sr-coach';

let storage: Storage;
let deps: StartRunDeps;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setNotificationBackend(storage); // same store the test reads notifications from
  setNotificationMuteResolver(async () => false); // default: nothing muted
  await resetScheduling();
  deps = { storage, hostSuite };
});
afterEach(() => {
  __resetHostExtPersistence();
  setNotificationMuteResolver(async () => false);
});

async function makeCircle(): Promise<{ circleId: string }> {
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: 'enr:sr', ownerSubject: COACH, name: 'Session cohort' });
  return { circleId: circle.id };
}

async function addLiveGrantee(circleId: string, subject: string): Promise<void> {
  await inviteToCircle(T, circleId, COACH, subject, ['action-status']);
  await acceptGrant(circleId, subject);
}

// ── 1. the daemon fires the session-reminder workflow ─────────────────────
describe('scheduleSession arms a workflow-bearing reminder job the daemon fires (ADR 0459 P3)', () => {
  it('fires openwop-app.kicktodo.session-reminder with the circle/atIso/conversation inputs seeded', async () => {
    const { circleId } = await makeCircle();
    const atMs = Date.now() + 2 * 60 * 60 * 1000; // 2h out ⇒ reminder fires ~1h from now
    const session = await scheduleSession(T, circleId, COACH, new Date(atMs).toISOString(), 'Weekly check-in');

    // The armed job carries the workflowId (the KT-PORT-3 fix) + the context.
    const jobId = sessionReminderJobId(T, circleId, session.atIso);
    // Fire the daemon well past the reminder's fire time.
    await processDueSchedules(deps, atMs + 60_000);

    const runs = await storage.listRuns({ limit: 100 });
    const fired = runs.filter((r) => r.workflowId === SESSION_REMINDER_WORKFLOW_ID);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.inputs).toEqual({ circleId, atIso: session.atIso, conversationId: session.conversationId });
    // (sanity — the reminder job id is deterministic and was the one armed)
    expect(jobId).toContain(circleId);
  });
});

// ── 2. sendSessionReminder: skip coach, respect mute, notify the rest ──────
describe('sendSessionReminder (ADR 0459 P3 — mute-respecting per recipient)', () => {
  const MUTED = 'user:sr-muted';
  const HEARD = 'user:sr-heard';

  async function remindersFor(): Promise<string[]> {
    const notifs = await storage.listNotifications({ tenantId: T });
    return notifs
      .filter((n) => (n.metadata as Record<string, unknown>)?.category === 'kicktodo-session-reminder')
      .map((n) => n.recipientUserId)
      .filter((r): r is string => typeof r === 'string');
  }

  it('notifies live grantees, skips the coach, and skips a muted recipient', async () => {
    const { circleId } = await makeCircle();
    await addLiveGrantee(circleId, MUTED);
    await addLiveGrantee(circleId, HEARD);
    const atMs = Date.now() + 2 * 60 * 60 * 1000;
    const session = await scheduleSession(T, circleId, COACH, new Date(atMs).toISOString(), 'Session');

    // Mute exactly ONE grantee (per ADR 0457) — checked BEFORE emit.
    setNotificationMuteResolver(async (_tenant, userId) => userId === MUTED);

    const res = await sendSessionReminder(T, { circleId, atIso: session.atIso, conversationId: session.conversationId });
    expect(res.notified).toBe(true);

    const recipients = await remindersFor();
    expect(recipients).toContain(HEARD);
    expect(recipients).not.toContain(MUTED); // muted
    expect(recipients).not.toContain(COACH); // the session host is skipped
  });

  it('an absent/cancelled session is an honest no-op (no delivery)', async () => {
    const { circleId } = await makeCircle();
    await addLiveGrantee(circleId, HEARD);
    const res = await sendSessionReminder(T, { circleId, atIso: '2030-01-01T00:00:00.000Z' });
    expect(res).toEqual({ notified: false, reason: 'session-not-scheduled' });
    expect(await remindersFor()).toEqual([]);
  });

  it('reports no-live-recipients when every grantee but the coach is muted', async () => {
    const { circleId } = await makeCircle();
    await addLiveGrantee(circleId, MUTED);
    const atMs = Date.now() + 2 * 60 * 60 * 1000;
    const session = await scheduleSession(T, circleId, COACH, new Date(atMs).toISOString(), 'Session');
    setNotificationMuteResolver(async (_tenant, userId) => userId === MUTED);
    const res = await sendSessionReminder(T, { circleId, atIso: session.atIso });
    expect(res).toEqual({ notified: false, reason: 'no-live-recipients' });
  });
});
