/**
 * ADR 0419 P3 — cohorts, the coach console, and inert plan proposals:
 *
 *  - exact CAS capacity (capacity 2 ⇒ the third join is refused 409-style),
 *    sequentially AND under a FORCED race on the last seat (both claimants read
 *    the same `seatsTaken` before either swaps — only the CAS can refuse one)
 *  - the coach caseload lists ONLY live coach-scoped grants (cross-workspace
 *    via the pointer index) and flags zero-progress participants
 *  - proposals are INERT: only the participant applies (bumping the plan
 *    revision through the ADR 0414 supersession path) or dismisses; a coach
 *    can never mutate the plan
 *
 * Every case builds its OWN cohort (`freshCohort`), so the file passes in any
 * order (`--sequence.shuffle`).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { RevisionCommandError } from '../src/features/kicktodo-core/replanService.js';
import {
  createCircle,
  inviteToCircle,
  acceptGrant,
  revokeGrant,
  CircleDeniedError,
  type AccountabilityCircle,
} from '../src/features/kicktodo-accountability/circleService.js';
import {
  createCohortDetail,
  getCohortDetail,
  joinCohort,
  indexGrantee,
  coachCaseload,
  proposePlanChange,
  listProposalsFor,
  resolveProposal,
  previewProposal,
  CohortFullError,
  CohortError,
  type CohortDetail,
} from '../src/features/kicktodo-accountability/cohortService.js';

const T = 'tenant-cohort';

let challengeId = '';

interface Fresh { circle: AccountabilityCircle; enrollmentId: string; owner: string; coach: string }

/** A new participant + cohort (capacity 2, owner holds seat 1). With `coach`, a
 *  coach is invited, accepted and pointer-indexed with the proposal scope. */
async function freshCohort(tag: string, opts: { coach?: boolean } = {}): Promise<Fresh> {
  const owner = `user:coh-${tag}-owner`;
  const coach = `user:coh-${tag}-coach`;
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId, challengeVersion: 1 });
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: owner, name: `Cohort ${tag}` });
  await createCohortDetail({ circle, actorSubject: owner, capacity: 2, startDateLocal: '2026-08-01' });
  if (opts.coach) {
    await inviteToCircle(T, circle.id, owner, coach, ['progress-summary', 'coach-plan-proposal']);
    await indexGrantee(coach, circle.id, T);
    await acceptGrant(circle.id, coach);
  }
  return { circle, enrollmentId: enrollment.id, owner, coach };
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: T, title: 'Cohort Challenge', summary: 's', outcome: 'o', durationDays: 14,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  challengeId = draft.id;
});

afterEach(() => { vi.restoreAllMocks(); });

describe('cohort capacity (exact CAS)', () => {
  it('capacity 2 (owner holds seat 1): one join fits, the next is refused', async () => {
    const { circle, owner } = await freshCohort('cap');
    await inviteToCircle(T, circle.id, owner, 'user:coh-m1', ['action-status']);
    await inviteToCircle(T, circle.id, owner, 'user:coh-m2', ['action-status']);

    const joined = await joinCohort(circle.id, 'user:coh-m1');
    expect(joined.seatsTaken).toBe(2);
    await expect(joinCohort(circle.id, 'user:coh-m2')).rejects.toBeInstanceOf(CohortFullError);
    expect((await getCohortDetail(T, circle.id))?.seatsTaken).toBe(2); // the refusal took nothing
  });

  it('two joins RACING for the last seat: exactly one wins, the other is refused full, seatsTaken stays at capacity', async () => {
    const { circle, owner } = await freshCohort('race');
    await inviteToCircle(T, circle.id, owner, 'user:coh-r1', ['action-status']);
    await inviteToCircle(T, circle.id, owner, 'user:coh-r2', ['action-status']);
    const cohortKey = `${T}::${circle.id}`;

    // Force the window: hold each claimant at `claimSeat`'s FIRST read of the
    // cohort row (the candidate read the capacity check runs on) until both have
    // arrived — so both see seatsTaken=1 and only the CAS can refuse one. The hold
    // sits BEFORE the guard, so a blind put (no CAS) is still caught. The stack
    // check scopes it to claimSeat (joinCohort's own `detail0` read is not held).
    let arrived = 0;
    let release: () => void = () => {};
    const bothIn = new Promise<void>((r) => { release = r; });
    const orig = DurableCollection.prototype.get;
    vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      if (id === cohortKey && arrived < 2 && (new Error().stack ?? '').includes('claimSeat')) {
        arrived += 1;
        if (arrived === 2) release();
        await Promise.race([bothIn, new Promise<void>((r) => setTimeout(r, 2000))]);
      }
      return orig.call(this, id);
    });

    const results = await Promise.allSettled([joinCohort(circle.id, 'user:coh-r1'), joinCohort(circle.id, 'user:coh-r2')]);
    expect(arrived, 'the race window was not forced — both claimants must reach claimSeat').toBe(2);

    const won = results.filter((r): r is PromiseFulfilledResult<CohortDetail> => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(CohortFullError);
    vi.restoreAllMocks();
    expect((await getCohortDetail(T, circle.id))?.seatsTaken).toBe(2);
  });
});

describe('coach console', () => {
  it('lists only live coach-scoped grants and flags zero-progress; revocation drops the row', async () => {
    const { circle, owner } = await freshCohort('console');
    const coach = 'user:coh-console-coach';
    await inviteToCircle(T, circle.id, owner, coach, ['progress-summary', 'coach-plan-proposal']);
    await indexGrantee(coach, circle.id, T);
    // The grant is 'invited' — caseload requires LIVE (active) → empty first.
    expect(await coachCaseload(coach)).toHaveLength(0);
    await acceptGrant(circle.id, coach);

    const rows = await coachCaseload(coach);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.circleName).toBe('Cohort console');
    expect(rows[0]!.summary?.totalRequiredActivities).toBe(1);
    // Day 1 with zero completions is NOT yet flagged (flag threshold: day ≥ 3).
    expect(rows[0]!.summary?.currentDay).toBe(1);
    expect(rows[0]!.flagged).toBe(false);

    await revokeGrant(T, circle.id, owner, coach);
    expect(await coachCaseload(coach)).toHaveLength(0);
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
    const { circle, enrollmentId, owner, coach } = await freshCohort('prose', { coach: true });
    const p = await proposePlanChange(circle.id, coach, 'Reduce to one action a day for a week.');
    expect(p.state).toBe('proposed');
    expect(p.commands).toBeUndefined(); // advice carries no executable change
    const before = await getEnrollment(T, enrollmentId);
    expect(before?.planRevision).toBe(1);

    // A stranger (or the coach) still cannot resolve it — the participant decides.
    await expect(resolveProposal(T, enrollmentId, p.id, coach, 'apply')).rejects.toBeInstanceOf(CircleDeniedError);

    // The load-bearing assertion: apply is a TYPED REFUSAL, not a silent no-op. A no-op
    // would still persist state 'applied' — the durable lie this ADR exists to remove.
    await expect(resolveProposal(T, enrollmentId, p.id, owner, 'apply')).rejects.toBeInstanceOf(CohortError);

    // And nothing moved: not the plan, not the record.
    expect((await getEnrollment(T, enrollmentId))?.planRevision).toBe(1);
    const still = await listProposalsFor(T, enrollmentId);
    expect(still.find((x) => x.id === p.id)?.state).toBe('proposed');

    // Advice is still dismissable — refusing to apply must not strand it.
    expect((await resolveProposal(T, enrollmentId, p.id, owner, 'dismiss')).state).toBe('dismissed');
  });

  it('a COMMAND-CARRYING proposal executes the coach\'s actual change on accept', async () => {
    const { circle, enrollmentId, owner, coach } = await freshCohort('cmd', { coach: true });
    const p = await proposePlanChange(circle.id, coach, 'Move your sessions to the morning.', [
      { lane: 'schedule', daypart: 'morning' },
    ]);
    expect(p.commands).toEqual([{ lane: 'schedule', daypart: 'morning' }]);
    expect((await getEnrollment(T, enrollmentId))?.schedulePreference?.daypart).toBeUndefined();

    // Still the participant's decision alone.
    await expect(resolveProposal(T, enrollmentId, p.id, coach, 'apply')).rejects.toBeInstanceOf(CircleDeniedError);

    const applied = await resolveProposal(T, enrollmentId, p.id, owner, 'apply');
    expect(applied.state).toBe('applied');

    // The PROPERTY, not the mechanism: the coach's specific ask is now true of the
    // enrollment. A revision bump alone would not distinguish this from the old bug.
    const after = await getEnrollment(T, enrollmentId);
    expect(after?.schedulePreference?.daypart).toBe('morning');
    expect(after?.planRevision).toBe(2);

    // Idempotent on re-resolve.
    expect((await resolveProposal(T, enrollmentId, p.id, owner, 'dismiss')).state).toBe('applied');
  });

  /**
   * ADR 0501 step 4. The preview exists only because step 3 landed: before it, a compare
   * over a proposal that could not execute would have made the false promise MORE
   * convincing. These pin the distinction that makes the preview honest.
   */
  it('an ADVICE-ONLY proposal previews as advice-only — NOT as an empty diff', async () => {
    const { circle, enrollmentId, owner, coach } = await freshCohort('advice', { coach: true });
    const p = await proposePlanChange(circle.id, coach, 'Try to get more sleep.');
    const preview = await previewProposal(T, enrollmentId, p.id, owner);
    // The load-bearing assertion. `previewRevisionCommands` returns one change per
    // command, so a naive implementation passing `commands ?? []` yields `changes: []` —
    // which renders as "no changes to your plan", a confident answer the system did not
    // earn. That is `proposalApplied: 'Applied'` moved one step earlier.
    expect(preview.kind).toBe('advice-only');
    expect(preview).not.toHaveProperty('changes');
  });

  it('a COMMAND-CARRYING proposal previews the real change, and writes NOTHING', async () => {
    const { circle, enrollmentId, owner, coach } = await freshCohort('preview', { coach: true });
    const p = await proposePlanChange(circle.id, coach, 'Move your sessions to the morning.', [
      { lane: 'schedule', daypart: 'morning' },
    ]);
    const before = await getEnrollment(T, enrollmentId);

    const preview = await previewProposal(T, enrollmentId, p.id, owner);
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
    const { circle, enrollmentId, owner, coach } = await freshCohort('prevauth', { coach: true });
    const p = await proposePlanChange(circle.id, coach, 'Move to mornings.', [{ lane: 'schedule', daypart: 'morning' }]);
    // The preview leaks the coach's note and the plan's shape, so it carries the same
    // ownership boundary as resolveProposal — and the same uniform refusal, so proposal
    // existence stays unobservable to anyone else.
    for (const other of [coach, 'user:stranger']) {
      await expect(previewProposal(T, enrollmentId, p.id, other)).rejects.toBeInstanceOf(CircleDeniedError);
    }
    // Positive control: the participant's own preview succeeds.
    expect((await previewProposal(T, enrollmentId, p.id, owner)).kind).toBe('changes');
  });

  it('rejects a proposed command outside the three lanes, at AUTHORING time', async () => {
    const { circle, coach } = await freshCohort('lanes', { coach: true });
    // The coach learns immediately, not at the participant's accept. Shares
    // kicktodo-core's validator, so the closed world cannot fork.
    const refused = proposePlanChange(circle.id, coach, 'Add a brand new activity.', [{ lane: 'invent-activity' }]);
    await expect(refused).rejects.toBeInstanceOf(RevisionCommandError);
    await expect(refused).rejects.toThrow('Command 0 has an unknown lane `invent-activity`');
    // Positive control: the SAME coach may author an in-lane command (the refusal is
    // the validator, not a missing grant).
    expect((await proposePlanChange(circle.id, coach, 'Mornings.', [{ lane: 'schedule', daypart: 'morning' }])).state).toBe('proposed');
  });
});
