/**
 * KTFULL-B10/B11 — CONCURRENT capacity safety.
 *
 * The audit's exact criticism of my original suite: "The test is sequential and
 * cannot catch two buyers passing the same pre-check." So this one fires the
 * contending operations with `Promise.all` and asserts on the INVARIANT
 * (seatsTaken never exceeds capacity) rather than on a happy path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { createCircle, inviteToCircle, liveGrant } from '../src/features/kicktodo-accountability/circleService.js';
import {
  createCohortDetail, getCohortDetail, holdSeat, joinCohort, CohortFullForHoldError,
} from '../src/features/kicktodo-accountability/cohortService.js';

const T = 'tenant-seat-race';
const COACH = 'user:race-coach';

/** `createCohortDetail` seats the coach, so N buyer seats needs capacity N+1. */
async function cohortWithBuyerSeats(buyerSeats: number): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'Race', summary: 's', outcome: 'o', durationDays: 2,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: COACH, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: COACH, name: 'Cohort' });
  await createCohortDetail({ circle, actorSubject: COACH, capacity: buyerSeats + 1, startDateLocal: '2099-01-01' });
  return circle.id;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

describe('concurrent seat holds cannot oversell (KTFULL-B10)', () => {
  it('EIGHT buyers racing for ONE seat: exactly one wins, capacity is never exceeded', async () => {
    const circleId = await cohortWithBuyerSeats(1);
    const buyers = Array.from({ length: 8 }, (_, i) => `user:racer-${i}`);

    const results = await Promise.all(
      buyers.map((b) => holdSeat(T, circleId, b).then(() => 'won' as const).catch((e) => (e instanceof CohortFullForHoldError ? 'full' : 'error'))),
    );

    expect(results.filter((r) => r === 'error')).toHaveLength(0);
    expect(results.filter((r) => r === 'won')).toHaveLength(1);      // exactly one seat sold
    const detail = await getCohortDetail(T, circleId);
    expect(detail!.seatsTaken).toBeLessThanOrEqual(detail!.capacity); // THE invariant
    expect(detail!.seatsTaken).toBe(2);                               // coach + one buyer
  });

  it('racing for THREE seats sells exactly three, never four', async () => {
    const circleId = await cohortWithBuyerSeats(3);
    const buyers = Array.from({ length: 10 }, (_, i) => `user:racer3-${i}`);
    const results = await Promise.all(
      buyers.map((b) => holdSeat(T, circleId, b).then(() => 'won' as const).catch(() => 'full' as const)),
    );
    expect(results.filter((r) => r === 'won')).toHaveLength(3);
    const detail = await getCohortDetail(T, circleId);
    expect(detail!.seatsTaken).toBe(4); // coach + three
    expect(detail!.seatsTaken).toBeLessThanOrEqual(detail!.capacity);
  });
});

describe('joinCohort takes a seat only for a real member (KTFULL-B11)', () => {
  it('an UNINVITED join is refused and STRANDS NO SEAT', async () => {
    const circleId = await cohortWithBuyerSeats(2);
    const before = (await getCohortDetail(T, circleId))!.seatsTaken;
    await expect(joinCohort(circleId, 'user:never-invited')).rejects.toThrow();
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(before); // unchanged
  });

  it('a REPEATED join by an active member does not take a second seat', async () => {
    const circleId = await cohortWithBuyerSeats(3);
    await inviteToCircle(T, circleId, COACH, 'user:joiner', ['progress-summary']);
    await joinCohort(circleId, 'user:joiner');
    const after = (await getCohortDetail(T, circleId))!.seatsTaken;
    expect(await liveGrant(T, circleId, 'user:joiner')).toBeTruthy();

    await joinCohort(circleId, 'user:joiner');
    await joinCohort(circleId, 'user:joiner');
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(after); // idempotent
  });

  it('concurrent joins by DIFFERENT invited members respect capacity', async () => {
    const circleId = await cohortWithBuyerSeats(2);
    const members = ['user:cj-1', 'user:cj-2', 'user:cj-3', 'user:cj-4'];
    for (const m of members) await inviteToCircle(T, circleId, COACH, m, ['progress-summary']);

    const results = await Promise.all(
      members.map((m) => joinCohort(circleId, m).then(() => 'in' as const).catch(() => 'full' as const)),
    );
    expect(results.filter((r) => r === 'in')).toHaveLength(2);
    const detail = await getCohortDetail(T, circleId);
    expect(detail!.seatsTaken).toBeLessThanOrEqual(detail!.capacity);
  });
});
