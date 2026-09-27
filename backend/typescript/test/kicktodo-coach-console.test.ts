/**
 * ADR 0501 (console) — the coach's side of proposals:
 *
 *  - the caseload row carries the coach's OWN proposals (state, note, whether it
 *    is executable), never another coach's;
 *  - a dry run validates under the same grant as propose, returns the humanized
 *    lines, reads no plan and persists nothing; an off-lane command is refused
 *    with the same typed error propose would raise; a non-coach is refused.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { RevisionCommandError, describeRevisionCommands } from '../src/features/kicktodo-core/replanService.js';
import { createCircle, inviteToCircle, acceptGrant, CircleDeniedError, type AccountabilityCircle } from '../src/features/kicktodo-accountability/circleService.js';
import { indexGrantee, coachCaseload, proposePlanChange, dryRunProposal, listProposalsFor } from '../src/features/kicktodo-accountability/cohortService.js';

const T = 'tenant-coach-console';
const ALICE = 'user:cc-alice';
const COACH = 'user:cc-coach';
const OTHER_COACH = 'user:cc-other';
let circle: AccountabilityCircle;
let enrollmentId = '';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Console Challenge', summary: 's', outcome: 'o', durationDays: 14,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: ALICE, challengeId: draft.id, challengeVersion: 1 });
  enrollmentId = enrollment.id;
  circle = await createCircle({ tenantId: T, type: 'coach', enrollmentId, ownerSubject: ALICE, name: 'Coached' });
  for (const c of [COACH, OTHER_COACH]) {
    await inviteToCircle(T, circle.id, ALICE, c, ['coach-plan-proposal']);
    await acceptGrant(circle.id, c);
    await indexGrantee(c, circle.id, T);
  }
});

describe('dry run (ADR 0501 console)', () => {
  it('humanizes a valid list under the coach grant, reads no plan, persists nothing', async () => {
    const out = await dryRunProposal(circle.id, COACH, [{ lane: 'schedule', daypart: 'morning' }, { lane: 'recovery' }]);
    expect(out.lines).toEqual(['Move your sessions to the morning.', 'Collapse your missed activities into a single recovery day.']);
    expect(out.commands).toHaveLength(2);
    expect(await listProposalsFor(T, enrollmentId)).toHaveLength(0); // nothing persisted
    // The pure describer never needs a tenant or an enrollment — no plan read.
    expect(describeRevisionCommands([{ lane: 'move', day: 3, toDate: '2026-10-01' }])).toEqual(['Move day 3 to 2026-10-01.']);
  });

  it('refuses an off-lane command with the propose path’s typed error, and refuses a non-coach', async () => {
    await expect(dryRunProposal(circle.id, COACH, [{ lane: 'delete-everything' }])).rejects.toBeInstanceOf(RevisionCommandError);
    await expect(dryRunProposal(circle.id, COACH, Array.from({ length: 6 }, () => ({ lane: 'recovery' })))).rejects.toBeInstanceOf(RevisionCommandError);
    await expect(dryRunProposal(circle.id, 'user:cc-stranger', [{ lane: 'recovery' }])).rejects.toBeInstanceOf(CircleDeniedError);
  });
});

describe('caseload carries the coach’s own proposals', () => {
  it('lists mine with state + executability; another coach’s never appear', async () => {
    await proposePlanChange(circle.id, COACH, 'Try mornings.', [{ lane: 'schedule', daypart: 'morning' }]);
    await proposePlanChange(circle.id, COACH, 'Just a thought.');
    await proposePlanChange(circle.id, OTHER_COACH, 'Other coach here.', [{ lane: 'recovery' }]);
    const mine = (await coachCaseload(COACH)).find((r) => r.circleId === circle.id)!;
    // Order-independent: two proposals created in the same millisecond sort arbitrarily.
    const byNote = new Map(mine.proposals.map((p) => [p.note, p]));
    expect([...byNote.keys()].sort()).toEqual(['Just a thought.', 'Try mornings.']);
    expect(byNote.get('Try mornings.')).toMatchObject({ hasCommands: true, state: 'proposed' });
    expect(byNote.get('Just a thought.')).toMatchObject({ hasCommands: false, state: 'proposed' });
    const theirs = (await coachCaseload(OTHER_COACH)).find((r) => r.circleId === circle.id)!;
    expect(theirs.proposals.map((p) => p.note)).toEqual(['Other coach here.']);
  });
});
