/**
 * KTFULL-B10/B11 — CONCURRENT capacity safety.
 *
 * The audit's exact criticism of my original suite: "The test is sequential and
 * cannot catch two buyers passing the same pre-check." So this one fires the
 * contending operations with `Promise.all` and asserts on the INVARIANT
 * (seatsTaken never exceeds capacity) rather than on a happy path.
 *
 * FORCED RACE (grade-tests w40, wave-39 pattern): unforced `Promise.all` only
 * interleaves by accident of equal await counts. `lockstep()` holds every racer's
 * first TWO reads of the cohort row (the pre-read + `claimSeat`'s attempt-0
 * candidate read) until all N racers have arrived, so every racer provably reads
 * the SAME `seatsTaken` before anyone CASes. `arrivals()` is asserted, so a hold
 * that never fired cannot pass silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { createCircle, inviteToCircle, liveGrant, revokeGrant, CircleDeniedError } from '../src/features/kicktodo-accountability/circleService.js';
import {
  createCohortDetail, getCohortDetail, holdSeat, joinCohort, CohortFullForHoldError, CohortFullError, cohortOutcomeAggregate,
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

let storage: Storage;
let restoreBarrier: (() => void) | null = null;

/** Hold the first `racers × rounds` reads of ONE storage key in batches of
 *  `racers`: a batch is released only when every racer has arrived (2 s fallback
 *  so a broken hold fails the arrivals assert instead of hanging). */
function lockstep(key: string, racers: number, rounds: number): { arrivals: () => number } {
  const original = storage.kvGet.bind(storage);
  let arrivals = 0;
  let batch: Array<() => void> = [];
  const releaseBatch = (): void => { const b = batch; batch = []; for (const f of b) f(); };
  const spy = vi.spyOn(storage, 'kvGet').mockImplementation(async (k: string) => {
    if (k === key && arrivals < racers * rounds) {
      arrivals += 1;
      await new Promise<void>((release) => {
        batch.push(release);
        if (batch.length === racers) releaseBatch();
        else if (batch.length === 1) setTimeout(releaseBatch, 2000);
      });
    }
    return original(k);
  });
  restoreBarrier = () => spy.mockRestore();
  return { arrivals: () => arrivals };
}
const cohortKey = (circleId: string): string => `hostext:kicktodo-cohorts:${T}::${circleId}`;

afterEach(() => {
  restoreBarrier?.();
  restoreBarrier = null;
});

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

describe('concurrent seat holds cannot oversell (KTFULL-B10)', () => {
  it('EIGHT buyers racing for ONE seat: exactly one wins, capacity is never exceeded', async () => {
    const circleId = await cohortWithBuyerSeats(1);
    const buyers = Array.from({ length: 8 }, (_, i) => `user:racer-${i}`);
    const race = lockstep(cohortKey(circleId), buyers.length, 2);

    const results = await Promise.all(
      buyers.map((b) => holdSeat(T, circleId, b).then(() => 'won' as const).catch((e) => (e instanceof CohortFullForHoldError ? 'full' : 'error'))),
    );

    expect(race.arrivals(), 'the race was not forced — every racer must read before any CAS').toBe(16);
    expect(results.filter((r) => r === 'error')).toHaveLength(0);
    expect(results.filter((r) => r === 'won')).toHaveLength(1);      // exactly one seat sold
    const detail = await getCohortDetail(T, circleId);
    expect(detail!.seatsTaken).toBeLessThanOrEqual(detail!.capacity); // THE invariant
    expect(detail!.seatsTaken).toBe(2);                               // coach + one buyer
  });

  it('racing for THREE seats sells exactly three, never four', async () => {
    const circleId = await cohortWithBuyerSeats(3);
    const buyers = Array.from({ length: 10 }, (_, i) => `user:racer3-${i}`);
    const race = lockstep(cohortKey(circleId), buyers.length, 2);
    const results = await Promise.all(
      buyers.map((b) => holdSeat(T, circleId, b).then(() => 'won' as const).catch((e) => (e instanceof CohortFullForHoldError ? 'full' : 'error'))),
    );
    expect(race.arrivals()).toBe(20);
    expect(results.filter((r) => r === 'error'), 'a racer failed for a reason other than a full cohort').toHaveLength(0);
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
    await expect(joinCohort(circleId, 'user:never-invited')).rejects.toBeInstanceOf(CircleDeniedError);
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

    const race = lockstep(cohortKey(circleId), members.length, 2);
    const results = await Promise.all(
      members.map((m) => joinCohort(circleId, m).then(() => 'in' as const).catch((e) => (e instanceof CohortFullError ? 'full' : 'error'))),
    );
    expect(race.arrivals()).toBe(8);
    expect(results.filter((r) => r === 'error'), 'a join failed for a reason other than a full cohort').toHaveLength(0);
    expect(results.filter((r) => r === 'in')).toHaveLength(2);
    const detail = await getCohortDetail(T, circleId);
    expect(detail!.seatsTaken).toBeLessThanOrEqual(detail!.capacity);
    expect(detail!.seatsTaken).toBe(3); // coach + exactly two members
  });
});

// KT-COHORT-FULL-GRANT-1 — found by grade-tests wave 40, FIXED by #4780 (27d3e6618).
describe('a FULL cohort refuses a join without granting access (KT-COHORT-FULL-GRANT-1)', () => {
  it('the refused invitee holds no live grant, adds no active member, and is refused again on retry', async () => {
    const circleId = await cohortWithBuyerSeats(1);
    await inviteToCircle(T, circleId, COACH, 'user:full-in', ['progress-summary']);
    await inviteToCircle(T, circleId, COACH, 'user:full-out', ['progress-summary']);
    await joinCohort(circleId, 'user:full-in');
    const seatsBefore = (await getCohortDetail(T, circleId))!.seatsTaken;
    const activeBefore = (await cohortOutcomeAggregate(T, circleId))!.activeMembers;

    await expect(joinCohort(circleId, 'user:full-out')).rejects.toBeInstanceOf(CohortFullError);

    // The org-programs k-anonymity floor counts active grants.
    expect((await cohortOutcomeAggregate(T, circleId))!.activeMembers).toBe(activeBefore);
    // Before the fix the grant went ACTIVE before the seat check threw.
    expect(await liveGrant(T, circleId, 'user:full-out')).toBeNull();
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(seatsBefore);
    // Before the fix the `liveGrant` early return made a retry "succeed" with no seat.
    await expect(joinCohort(circleId, 'user:full-out')).rejects.toBeInstanceOf(CohortFullError);
  });

  it('a REVOKED invitation is refused before any seat is claimed', async () => {
    const circleId = await cohortWithBuyerSeats(2);
    await inviteToCircle(T, circleId, COACH, 'user:revoked', ['progress-summary']);
    await revokeGrant(T, circleId, COACH, 'user:revoked');
    const before = (await getCohortDetail(T, circleId))!.seatsTaken;
    await expect(joinCohort(circleId, 'user:revoked')).rejects.toBeInstanceOf(CircleDeniedError);
    expect((await getCohortDetail(T, circleId))!.seatsTaken).toBe(before);
    expect(await liveGrant(T, circleId, 'user:revoked')).toBeNull();
  });
});
