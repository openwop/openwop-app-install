/**
 * KT-PREVIEW-SUBGUARD — `previewRevisionCommands` (the §5.5 compare + the coach
 * proposal preview) must refuse a substitution that `applyRevisionCommands`
 * would refuse. Before this, preview ran only the move-lane guards, so the
 * compare view showed "Swap … for a publisher-approved alternative" for an
 * alternative that does not exist, and apply then refused it at accept.
 *
 * Own file, like `kicktodo-replan-atomic.test.ts`, to stay clear of the
 * grade-tests rewrite of `kicktodo-replan.test.ts`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, materializeOccurrences, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { applyRevisionCommands, previewRevisionCommands, RevisionCommandError } from '../src/features/kicktodo-core/replanService.js';
import { registerPlanRevisedListener, __resetPlanRevisedListenersForTest } from '../src/host/planRevisedHook.js';

const storage = await openStorage('memory://');
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kt-preview-subguard-')) });

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

async function refusal(p: Promise<unknown>): Promise<RevisionCommandError> {
  const caught = await p.then(() => undefined, (err: unknown) => err);
  expect(caught).toBeInstanceOf(RevisionCommandError);
  return caught as RevisionCommandError;
}

describe('KT-PREVIEW-SUBGUARD — preview refuses what apply refuses', () => {
  it('an unavailable alternative: preview AND apply refuse with the same index + message', async () => {
    const T = 'tenant-preview-sub-bad';
    const OWNER = 'user:preview-bad';
    const { enrollmentId, cardId } = await setup(T, OWNER);
    const commands = [{ lane: 'schedule', daypart: 'evening' }, { lane: 'substitute', cardId, alternativeId: 'nope' }];

    const p = await refusal(previewRevisionCommands(T, { enrollmentId, subject: OWNER, commands }));
    const a = await refusal(applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands }));
    expect(p.failedIndex).toBe(1);
    expect(p.message).toBe('Command 1 (substitute) failed: That substitution is not available.');
    expect({ idx: p.failedIndex, msg: p.message, status: p.httpStatus }).toEqual({ idx: a.failedIndex, msg: a.message, status: a.httpStatus });
  });

  it('a card that is not in the plan is refused at preview too', async () => {
    const T = 'tenant-preview-sub-card';
    const OWNER = 'user:preview-card';
    const { enrollmentId } = await setup(T, OWNER);
    const p = await refusal(previewRevisionCommands(T, {
      enrollmentId, subject: OWNER,
      commands: [{ lane: 'substitute', cardId: `kicktodo:${enrollmentId}:2000-01-01:run:r1`, alternativeId: 'walk' }],
    }));
    expect(p.failedIndex).toBe(0);
  });

  it('control: an available alternative previews as a change and writes nothing', async () => {
    const T = 'tenant-preview-sub-ok';
    const OWNER = 'user:preview-ok';
    const { enrollmentId, cardId } = await setup(T, OWNER);
    const before = await getEnrollment(T, enrollmentId);
    const { changes } = await previewRevisionCommands(T, {
      enrollmentId, subject: OWNER,
      commands: [{ lane: 'substitute', cardId, alternativeId: 'walk' }],
    });
    expect(changes).toEqual([{ lane: 'substitute', line: 'Swap “Day 1: Run 5k” for “Walk 5k”.' }]);
    expect(await getEnrollment(T, enrollmentId)).toEqual(before);
    expect(revised).toEqual([]);
  });
});
