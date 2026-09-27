/**
 * ADR 0431 P1–P3 — paid cohort seats (reserve → pay → confirm).
 *
 *  - a HOLD occupies the shared capacity CAS, so two buyers cannot both take
 *    the last seat; re-holding EXTENDS rather than double-counting
 *  - an expired hold is reaped lazily and frees the seat
 *  - a paid order CONSUMES a live hold (no double increment) and is idempotent
 *  - paid-but-full FAILS CLOSED (no silent oversell) — the caller flags refund
 *  - a refund BEFORE start releases the seat; after start it does not resell,
 *    and neither deletes history
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { createCircle, liveGrant } from '../src/features/kicktodo-accountability/circleService.js';
import {
  createCohortDetail, getCohortDetail, holdSeat, liveHold, confirmSeat, releaseSeat,
  CohortFullForHoldError,
} from '../src/features/kicktodo-accountability/cohortService.js';

const T = 'tenant-seats';
const COACH = 'user:seat-coach';

/** NOTE: `createCohortDetail` starts `seatsTaken` at 1 — the COACH occupies a
 *  seat — so a cohort with N buyer seats needs capacity N+1. */
async function makeCohort(buyerSeats: number, startDateLocal = '2099-01-01'): Promise<string> {
  const capacity = buyerSeats + 1;
  const draft = await createDraft({
    tenantId: T, title: 'Coached', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: COACH, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: COACH, name: 'Cohort' });
  await createCohortDetail({ circle, actorSubject: COACH, capacity, startDateLocal });
  return circle.id;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

describe('seat holds (P2)', () => {
  it('a hold occupies the shared CAS; the last seat cannot be double-held; re-holding extends', async () => {
    const circleId = await makeCohort(1); // 1 buyer seat (+ the coach)
    await holdSeat(T, circleId, 'user:buyer-a');
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2);

    // The only seat is held — a second buyer is refused.
    await expect(holdSeat(T, circleId, 'user:buyer-b')).rejects.toBeInstanceOf(CohortFullForHoldError);

    // Re-holding EXTENDS the same seat rather than taking another.
    await holdSeat(T, circleId, 'user:buyer-a');
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2);
  });

  it('an expired hold is reaped lazily and frees the seat for someone else', async () => {
    const circleId = await makeCohort(1);
    await holdSeat(T, circleId, 'user:buyer-a', -1); // already expired
    expect(await liveHold(T, circleId, 'user:buyer-a')).toBeNull();
    // The next hold reaps it and succeeds.
    await holdSeat(T, circleId, 'user:buyer-b');
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2);
  });
});

describe('confirm + refund (P3)', () => {
  it('a paid order consumes a live hold WITHOUT double-counting, and is idempotent', async () => {
    const circleId = await makeCohort(2);
    await holdSeat(T, circleId, 'user:buyer-a');
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2);

    expect((await confirmSeat(T, circleId, 'user:buyer-a')).granted).toBe(true);
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2); // consumed, not re-incremented
    expect(await liveGrant(T, circleId, 'user:buyer-a')).toBeTruthy();

    // Replayed webhook converges.
    const again = await confirmSeat(T, circleId, 'user:buyer-a');
    expect(again.granted).toBe(true);
    expect(again.reason).toBe('already-member');
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2);
  });

  it('paid-but-full FAILS CLOSED — never a silent oversell', async () => {
    const circleId = await makeCohort(1);
    await confirmSeat(T, circleId, 'user:buyer-a');           // fills it
    const result = await confirmSeat(T, circleId, 'user:buyer-b'); // paid, no hold, full
    expect(result.granted).toBe(false);
    expect(result.reason).toBe('cohort-full');
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(2); // capacity respected
  });

  it('a refund BEFORE start releases the seat; after start it does not resell', async () => {
    const before = await makeCohort(2, '2099-01-01');
    await confirmSeat(T, before, 'user:buyer-a');
    expect((await releaseSeat(T, before, 'user:buyer-a', '2098-12-01')).released).toBe(true);
    expect((await getCohortDetail(T, before))!.seatsTaken).toBe(1); // back to the coach only

    const started = await makeCohort(2, '2020-01-01');
    await confirmSeat(T, started, 'user:buyer-c');
    const after = await releaseSeat(T, started, 'user:buyer-c', '2026-07-19');
    expect(after.released).toBe(false);                                  // no mid-cohort backfill
    expect((await getCohortDetail(T, started))!.seatsTaken).toBe(2);
  });
});
