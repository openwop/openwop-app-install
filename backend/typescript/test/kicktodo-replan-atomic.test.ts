/**
 * KT-REPLAN-HALFAPPLY-1 — `applyRevisionCommands` must refuse a command list
 * BEFORE writing any of it when a later command's lane guard would refuse.
 *
 * Measured on 482da8a52 (b1's grader): `[schedule evening, substitute <real
 * card> → 'nope']` threw `RevisionCommandError` (failedIndex 1) AFTER the
 * schedule lane had persisted `schedulePreference.daypart` and registered the
 * reminder job — while `planRevision` stayed put and no plan-revised event
 * fired, so nothing downstream ever learned of the half-applied write.
 *
 * Kept in its own file so it never conflicts with the grade-tests rewrite of
 * `kicktodo-replan.test.ts`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { listJobs } from '../src/host/schedulingService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, materializeOccurrences, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { applyRevisionCommands, RevisionCommandError } from '../src/features/kicktodo-core/replanService.js';
import { registerPlanRevisedListener, __resetPlanRevisedListenersForTest } from '../src/host/planRevisedHook.js';

const storage = await openStorage('memory://');
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kt-replan-atomic-')) });

const ACTIVITY = {
  stableActivityId: 'run', day: 1, title: 'Run 5k', instructions: 'Run', evidencePolicy: 'attestation' as const,
  alternatives: [{ stableActivityId: 'walk', title: 'Walk 5k', instructions: 'Walk', evidencePolicy: 'attestation' as const }],
};

let revised: string[];
beforeEach(() => {
  __clearEnrollGuards();
  revised = [];
  registerPlanRevisedListener((ev) => { revised.push(ev.enrollmentId); });
});
afterEach(() => { __resetPlanRevisedListenersForTest(); });

async function setup(tenant: string, owner: string): Promise<{ enrollmentId: string; cardId: string }> {
  const draft = await createDraft({ tenantId: tenant, title: 'Atomic', summary: 's', outcome: 'o', durationDays: 5, activities: [ACTIVITY] as never });
  await publishChallenge(tenant, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: tenant, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  // The card id comes from the plan itself — never a literal date (date bomb).
  const occs = await materializeOccurrences(tenant, enrollment.id);
  const cardId = occs.find((o) => o.stableActivityId === 'run')?.cardId;
  if (!cardId) throw new Error('setup: day-1 occurrence did not materialize');
  return { enrollmentId: enrollment.id, cardId };
}

async function reminderJobs(tenant: string, enrollmentId: string): Promise<number> {
  return (await listJobs(tenant)).filter((j) => j.jobId.includes(enrollmentId)).length;
}

async function refusal(p: Promise<unknown>): Promise<RevisionCommandError> {
  const caught = await p.then(() => undefined, (err: unknown) => err);
  expect(caught).toBeInstanceOf(RevisionCommandError);
  return caught as RevisionCommandError;
}

describe('KT-REPLAN-HALFAPPLY-1 — a refused list writes NOTHING', () => {
  it('[schedule, substitute(unavailable alternative)] → refused at index 1, daypart + reminder job untouched', async () => {
    const T = 'tenant-atomic-sub';
    const OWNER = 'user:half';
    const { enrollmentId, cardId } = await setup(T, OWNER);
    const before = await getEnrollment(T, enrollmentId);

    const err = await refusal(applyRevisionCommands(T, {
      enrollmentId, subject: OWNER,
      commands: [{ lane: 'schedule', daypart: 'evening' }, { lane: 'substitute', cardId, alternativeId: 'nope' }],
    }));
    expect(err.failedIndex).toBe(1);
    expect(err.message).toBe('Command 1 (substitute) failed: That substitution is not available.');

    const after = await getEnrollment(T, enrollmentId);
    expect(after?.schedulePreference).toEqual(before?.schedulePreference);
    expect(after?.planRevision).toBe(before?.planRevision);
    expect(await reminderJobs(T, enrollmentId)).toBe(0);
    expect(revised).toEqual([]);
  });

  it('[schedule, move(day out of range)] → refused at index 1, nothing written', async () => {
    const T = 'tenant-atomic-move';
    const OWNER = 'user:half-move';
    const { enrollmentId } = await setup(T, OWNER);
    const before = await getEnrollment(T, enrollmentId);

    const err = await refusal(applyRevisionCommands(T, {
      enrollmentId, subject: OWNER,
      commands: [{ lane: 'schedule', daypart: 'morning' }, { lane: 'move', day: 99, toDate: before!.startDateLocal }],
    }));
    expect(err.failedIndex).toBe(1);
    expect(err.message).toBe('Command 1 (move) failed: bad-day');

    const after = await getEnrollment(T, enrollmentId);
    expect(after?.schedulePreference).toEqual(before?.schedulePreference);
    expect(after?.planRevision).toBe(before?.planRevision);
    expect(await reminderJobs(T, enrollmentId)).toBe(0);
    expect(revised).toEqual([]);
  });

  it('control: the same list with an AVAILABLE alternative applies in full (the pre-flight does not over-refuse)', async () => {
    const T = 'tenant-atomic-ok';
    const OWNER = 'user:whole';
    const { enrollmentId, cardId } = await setup(T, OWNER);
    const before = await getEnrollment(T, enrollmentId);

    const r = await applyRevisionCommands(T, {
      enrollmentId, subject: OWNER,
      commands: [{ lane: 'schedule', daypart: 'evening' }, { lane: 'substitute', cardId, alternativeId: 'walk' }],
    });
    expect(r).toEqual({ applied: true, results: [{ lane: 'schedule' }, { lane: 'substitute' }] });

    const after = await getEnrollment(T, enrollmentId);
    expect(after?.schedulePreference?.daypart).toBe('evening');
    expect(after?.planRevision).toBe(before!.planRevision + 1);
    expect(await reminderJobs(T, enrollmentId)).toBe(1);
    expect(revised).toEqual([enrollmentId]);
  });
});
