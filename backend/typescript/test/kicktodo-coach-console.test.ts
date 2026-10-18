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
/** A live member of the SAME circle WITHOUT the `coach-plan-proposal` scope. */
const PARTNER = 'user:cc-partner';
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
  await inviteToCircle(T, circle.id, ALICE, PARTNER, ['action-status']);
  await acceptGrant(circle.id, PARTNER);
  await indexGrantee(PARTNER, circle.id, T);
});

describe('dry run (ADR 0501 console)', () => {
  it('humanizes a valid list under the coach grant, reads no plan, persists nothing', async () => {
    // Count BEFORE (not "is 0"): the caseload case writes proposals to the same
    // enrollment, so an absolute zero would depend on run order.
    const before = (await listProposalsFor(T, enrollmentId)).length;
    const out = await dryRunProposal(circle.id, COACH, [{ lane: 'schedule', daypart: 'morning' }, { lane: 'recovery' }]);
    expect(out.lines).toEqual(['Move your sessions to the morning.', 'Collapse your missed activities into a single recovery day.']);
    expect(out.commands).toEqual([{ lane: 'schedule', daypart: 'morning' }, { lane: 'recovery' }]);
    expect(await listProposalsFor(T, enrollmentId)).toHaveLength(before); // nothing persisted
    // The pure describer never needs a tenant or an enrollment — no plan read.
    expect(describeRevisionCommands([{ lane: 'move', day: 3, toDate: '2026-10-01' }])).toEqual(['Move day 3 to 2026-10-01.']);
  });

  it('refuses an off-lane command with the propose path’s typed error, and refuses a non-coach', async () => {
    // HONEST CEILING (double guard): dryRunProposal's own validateRevisionCommands
    // call is shadowed by describeRevisionCommands, which re-validates the same list
    // (replanService.ts) — removing the first call changes nothing here (round-1 probe
    // w41g2-cc-dry-validate: vacuous). The shared validator is the guard that holds,
    // and its messages are asserted exactly below (reprobe w41g2-cc-cap-r2).
    await expect(dryRunProposal(circle.id, COACH, [{ lane: 'delete-everything' }])).rejects.toThrow(
      new RevisionCommandError('validation_error', 'Command 0 has an unknown lane `delete-everything` (allowed: schedule|substitute|recovery|move).', 400, 0),
    );
    await expect(dryRunProposal(circle.id, COACH, Array.from({ length: 6 }, () => ({ lane: 'recovery' })))).rejects.toThrow('A revision carries at most 5 commands.');
    await expect(dryRunProposal(circle.id, 'user:cc-stranger', [{ lane: 'recovery' }])).rejects.toBeInstanceOf(CircleDeniedError);
    // A LIVE member of the circle without the coach scope is refused too (the scope
    // half of the shared grant check, not just membership).
    await expect(dryRunProposal(circle.id, PARTNER, [{ lane: 'recovery' }])).rejects.toBeInstanceOf(CircleDeniedError);
  });
});

describe('caseload carries the coach’s own proposals', () => {
  it('lists mine with state + executability; another coach’s never appear', async () => {
    await proposePlanChange(circle.id, COACH, 'Try mornings.', [{ lane: 'schedule', daypart: 'morning' }]);
    await proposePlanChange(circle.id, COACH, 'Just a thought.');
    await proposePlanChange(circle.id, OTHER_COACH, 'Other coach here.', [{ lane: 'recovery' }]);
    const mine = (await coachCaseload(COACH)).find((r) => r.circleId === circle.id);
    if (!mine) throw new Error('the coach holds a live coach-plan-proposal grant on this circle');
    // Order-independent: two proposals created in the same millisecond sort arbitrarily.
    const byNote = new Map(mine.proposals.map((p) => [p.note, p]));
    expect([...byNote.keys()].sort()).toEqual(['Just a thought.', 'Try mornings.']);
    expect(byNote.get('Try mornings.')).toMatchObject({ hasCommands: true, state: 'proposed' });
    expect(byNote.get('Just a thought.')).toMatchObject({ hasCommands: false, state: 'proposed' });
    const theirs = (await coachCaseload(OTHER_COACH)).find((r) => r.circleId === circle.id);
    if (!theirs) throw new Error('the other coach holds a live grant too');
    expect(theirs.proposals.map((p) => p.note)).toEqual(['Other coach here.']);
    // The partner (no coach scope) has NO caseload row for this circle at all.
    expect((await coachCaseload(PARTNER)).some((r) => r.circleId === circle.id)).toBe(false);
  });
});
