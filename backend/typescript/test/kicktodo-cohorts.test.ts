/**
 * ADR 0419 P3 — cohorts, the coach console, and inert plan proposals:
 *
 *  - exact CAS capacity (capacity 2 ⇒ the third join is refused 409-style)
 *  - the coach caseload lists ONLY live coach-scoped grants (cross-workspace
 *    via the pointer index) and flags zero-progress participants
 *  - proposals are INERT: only the participant applies (bumping the plan
 *    revision through the ADR 0414 supersession path) or dismisses; a coach
 *    can never mutate the plan
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import {
  createCircle,
  inviteToCircle,
  revokeGrant,
  CircleDeniedError,
  type AccountabilityCircle,
} from '../src/features/kicktodo-accountability/circleService.js';
import {
  createCohortDetail,
  joinCohort,
  indexGrantee,
  coachCaseload,
  proposePlanChange,
  listProposalsFor,
  resolveProposal,
  previewProposal,
  CohortFullError,
  CohortError,
} from '../src/features/kicktodo-accountability/cohortService.js';

const T = 'tenant-cohort';
const ALICE = 'user:coh-alice';
const COACH = 'user:coh-coach';

let circle: AccountabilityCircle;
let enrollmentId = '';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Cohort Challenge', summary: 's', outcome: 'o', durationDays: 14,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: ALICE, challengeId: draft.id, challengeVersion: 1 });
  enrollmentId = enrollment.id;
  circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId, ownerSubject: ALICE, name: 'March Cohort' });
});

describe('cohort capacity (exact CAS)', () => {
  it('capacity 2 (owner holds seat 1): one join fits, the next is refused', async () => {
    await createCohortDetail({ circle, actorSubject: ALICE, capacity: 2, startDateLocal: '2026-08-01' });
    await inviteToCircle(T, circle.id, ALICE, 'user:coh-m1', ['action-status']);
    await inviteToCircle(T, circle.id, ALICE, 'user:coh-m2', ['action-status']);

    const joined = await joinCohort(circle.id, 'user:coh-m1');
    expect(joined.seatsTaken).toBe(2);
    await expect(joinCohort(circle.id, 'user:coh-m2')).rejects.toBeInstanceOf(CohortFullError);
  });
});

describe('coach console', () => {
  it('lists only live coach-scoped grants and flags zero-progress; revocation drops the row', async () => {
    await inviteToCircle(T, circle.id, ALICE, COACH, ['progress-summary', 'coach-plan-proposal']);
    await indexGrantee(COACH, circle.id, T);
    // The grant is 'invited' — caseload requires LIVE (active) → empty first.
    expect(await coachCaseload(COACH)).toHaveLength(0);
    const { acceptGrant } = await import('../src/features/kicktodo-accountability/circleService.js');
    await acceptGrant(circle.id, COACH);

    const rows = await coachCaseload(COACH);
    expect(rows).toHaveLength(1);
    expect(rows[0].circleName).toBe('March Cohort');
    expect(rows[0].summary?.totalRequiredActivities).toBe(1);
    // Day 1 with zero completions is NOT yet flagged (flag threshold: day ≥ 3).
    expect(rows[0].flagged).toBe(false);

    await revokeGrant(T, circle.id, ALICE, COACH);
    expect(await coachCaseload(COACH)).toHaveLength(0);
    // Restore for the proposal tests.
    await inviteToCircle(T, circle.id, ALICE, COACH, ['coach-plan-proposal']);
    await acceptGrant(circle.id, COACH);
  });
});

describe('inert plan proposals', () => {
  /**
   * ADR 0501 steps 2+3. The PREVIOUS version of this test asserted the defect: it
   * created a prose-only proposal ("Reduce to one action a day for a week"), applied
   * it, and expected `planRevision` to bump to 2. The revision DID bump — because
   * `applyPlanRevision` re-materialized the plan from the PARTICIPANT'S OWN settings —
   * while the coach's actual ask was never executed. The assertion watched the
   * mechanism fire, not the change happen, so it passed for the whole life of the bug
   * and would have kept passing.
   */
  it('a PROSE-ONLY proposal is advice: apply is refused, nothing is executed, nothing is marked applied', async () => {
    const p = await proposePlanChange(circle.id, COACH, 'Reduce to one action a day for a week.');
    expect(p.state).toBe('proposed');
    expect(p.commands).toBeUndefined(); // advice carries no executable change
    const before = await getEnrollment(T, enrollmentId);
    expect(before?.planRevision).toBe(1);

    // A stranger (or the coach) still cannot resolve it — the participant decides.
    await expect(resolveProposal(T, enrollmentId, p.id, COACH, 'apply')).rejects.toBeInstanceOf(CircleDeniedError);

    // The load-bearing assertion: apply is a TYPED REFUSAL, not a silent no-op. A no-op
    // would still persist state 'applied' — the durable lie this ADR exists to remove.
    await expect(resolveProposal(T, enrollmentId, p.id, ALICE, 'apply')).rejects.toBeInstanceOf(CohortError);

    // And nothing moved: not the plan, not the record.
    expect((await getEnrollment(T, enrollmentId))?.planRevision).toBe(1);
    const still = await listProposalsFor(T, enrollmentId);
    expect(still.find((x) => x.id === p.id)?.state).toBe('proposed');

    // Advice is still dismissable — refusing to apply must not strand it.
    expect((await resolveProposal(T, enrollmentId, p.id, ALICE, 'dismiss')).state).toBe('dismissed');
  });

  it('a COMMAND-CARRYING proposal executes the coach\'s actual change on accept', async () => {
    const p = await proposePlanChange(circle.id, COACH, 'Move your sessions to the morning.', [
      { lane: 'schedule', daypart: 'morning' },
    ]);
    expect(p.commands).toEqual([{ lane: 'schedule', daypart: 'morning' }]);

    // Still the participant's decision alone.
    await expect(resolveProposal(T, enrollmentId, p.id, COACH, 'apply')).rejects.toBeInstanceOf(CircleDeniedError);

    const applied = await resolveProposal(T, enrollmentId, p.id, ALICE, 'apply');
    expect(applied.state).toBe('applied');

    // The PROPERTY, not the mechanism: the coach's specific ask is now true of the
    // enrollment. A revision bump alone would not distinguish this from the old bug.
    const after = await getEnrollment(T, enrollmentId);
    expect(after?.schedulePreference?.daypart).toBe('morning');
    expect(after?.planRevision).toBe(2);

    // Idempotent on re-resolve.
    expect((await resolveProposal(T, enrollmentId, p.id, ALICE, 'dismiss')).state).toBe('applied');
  });

  /**
   * ADR 0501 step 4. The preview exists only because step 3 landed: before it, a compare
   * over a proposal that could not execute would have made the false promise MORE
   * convincing. These pin the distinction that makes the preview honest.
   */
  it('an ADVICE-ONLY proposal previews as advice-only — NOT as an empty diff', async () => {
    const p = await proposePlanChange(circle.id, COACH, 'Try to get more sleep.');
    const preview = await previewProposal(T, enrollmentId, p.id, ALICE);
    // The load-bearing assertion. `previewRevisionCommands` returns one change per
    // command, so a naive implementation passing `commands ?? []` yields `changes: []` —
    // which renders as "no changes to your plan", a confident answer the system did not
    // earn. That is `proposalApplied: 'Applied'` moved one step earlier.
    expect(preview.kind).toBe('advice-only');
    expect(preview).not.toHaveProperty('changes');
  });

  it('a COMMAND-CARRYING proposal previews the real change, and writes NOTHING', async () => {
    const p = await proposePlanChange(circle.id, COACH, 'Move your sessions to the morning.', [
      { lane: 'schedule', daypart: 'morning' },
    ]);
    const before = await getEnrollment(T, enrollmentId);

    const preview = await previewProposal(T, enrollmentId, p.id, ALICE);
    expect(preview.kind).toBe('changes');
    if (preview.kind !== 'changes') throw new Error('unreachable');
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]?.lane).toBe('schedule');

    // A DRY RUN: previewing must not apply. Asserted directly, because "preview" is a
    // name, not a guarantee — the only thing that makes it true is that nothing moved.
    const after = await getEnrollment(T, enrollmentId);
    expect(after?.planRevision).toBe(before?.planRevision);
    expect(after?.schedulePreference?.daypart).toBe(before?.schedulePreference?.daypart);
    expect((await listProposalsFor(T, enrollmentId)).find((x) => x.id === p.id)?.state).toBe('proposed');
  });

  it('preview is the PARTICIPANT\'s alone — the coach and strangers get the uniform refusal', async () => {
    const p = await proposePlanChange(circle.id, COACH, 'Move to mornings.', [{ lane: 'schedule', daypart: 'morning' }]);
    // The preview leaks the coach's note and the plan's shape, so it carries the same
    // ownership boundary as resolveProposal — and the same uniform refusal, so proposal
    // existence stays unobservable to anyone else.
    for (const other of [COACH, 'user:stranger']) {
      await expect(previewProposal(T, enrollmentId, p.id, other)).rejects.toBeInstanceOf(CircleDeniedError);
    }
  });

  it('rejects a proposed command outside the three lanes, at AUTHORING time', async () => {
    // The coach learns immediately, not at the participant's accept. Shares
    // kicktodo-core's validator, so the closed world cannot fork.
    await expect(
      proposePlanChange(circle.id, COACH, 'Add a brand new activity.', [{ lane: 'invent-activity' }]),
    ).rejects.toBeTruthy();
  });
});
