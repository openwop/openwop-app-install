/**
 * KTFULL-B12 — the seat sagas must be REPAIRABLE after a partial failure.
 *
 * Seat expiry, confirmation and refund span four owners (hold rows, the cohort
 * counter, grant rows, the grantee index) with no transaction across them.
 * Every step used to adjust `seatsTaken` by ARITHMETIC, so a failure between
 * two steps left the counter permanently wrong in a way nothing could detect
 * or repair — a decrement that never ran stranded capacity forever, and
 * retrying re-applied a delta instead of restating the truth.
 *
 * These tests inject the partial states directly (writing the durable rows the
 * way a mid-sequence crash would leave them) and prove `reconcileSeats`
 * converges to the derived truth.
 *
 * Grade-tests w40: the ARCH-C1 race is FORCED (every confirmer reads the cohort
 * row before anyone CASes — `lockstep`, asserted by arrivals), and the
 * grant-before-release ordering is proved with a REAL crash (the grant write
 * throws once) rather than by inspecting a happy-path end state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { createCircle, inviteToCircle, acceptGrant, liveGrant, revokeGrant } from '../src/features/kicktodo-accountability/circleService.js';
import {
  createCohortDetail, getCohortDetail, holdSeat, confirmSeat, joinCohort, reconcileSeats, SEAT_HOLD_TTL_MS,
} from '../src/features/kicktodo-accountability/cohortService.js';

/** Invite a subject so they can legitimately claim a seat via joinCohort. */
async function invited(subject: string, circleId: string): Promise<string> {
  await inviteToCircle(T, circleId, COACH, subject, ['progress-summary']);
  return subject;
}

const T = 'tenant-seat-saga';
const COACH = 'user:saga-coach';

/** A second handle on the hold keyspace — lets a test leave the exact row a
 *  crashed sequence would have left, rather than approximating it. */
interface SeatHoldRow { tenantId: string; circleId: string; buyerSubject: string; heldAt: string; expiresAt: string }
const holds = new DurableCollection<SeatHoldRow>(
  'kicktodo-seat-holds',
  (h) => `${h.tenantId}::${h.circleId}::${h.buyerSubject}`,
);

async function cohort(capacity: number): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'Saga', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: COACH, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: COACH, name: 'Saga' });
  await createCohortDetail({ circle, actorSubject: COACH, capacity, startDateLocal: '2099-01-01' });
  return circle.id;
}

let storage: Storage;
let restoreSpy: (() => void) | null = null;

/** Hold the first `racers × rounds` reads of ONE key in batches of `racers`
 *  (2 s fallback). See kicktodo-seat-concurrency.test.ts for the same helper. */
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
  restoreSpy = () => spy.mockRestore();
  return { arrivals: () => arrivals };
}

/** Make the NEXT write of a grant row for `subject` throw once — the crash a
 *  partial confirm would suffer between the hold and the grant. */
function crashNextGrantWrite(circleId: string, subject: string): { fired: () => boolean } {
  const original = storage.kvSet.bind(storage);
  let fired = false;
  const spy = vi.spyOn(storage, 'kvSet').mockImplementation(async (k: string, v: string) => {
    if (!fired && k === `hostext:kicktodo-grants:${T}::${circleId}::${subject}`) {
      fired = true;
      throw new Error('injected: grant write crashed');
    }
    return original(k, v);
  });
  restoreSpy = () => spy.mockRestore();
  return { fired: () => fired };
}

afterEach(() => {
  restoreSpy?.();
  restoreSpy = null;
});

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
});

describe('ARCH-C1 — confirmSeat must not oversell on the money path', () => {
  it('refuses the second concurrent paid confirmation for the last seat', async () => {
    // capacity 2 = the coach + ONE buyer. Two paid webhooks arrive together
    // for different buyers, neither holding a reservation. The pre-fix shape
    // read the count, compared it to capacity, then called an increment with
    // no capacity guard — so both passed and both incremented, overselling a
    // coached group. Money had already changed hands for both.
    const circleId = await cohort(2);
    for (const s of ['user:pay-a', 'user:pay-b']) {
      await inviteToCircle(T, circleId, COACH, s, ['progress-summary']);
    }

    const race = lockstep(`hostext:kicktodo-cohorts:${T}::${circleId}`, 2, 2);
    const results = await Promise.all([
      confirmSeat(T, circleId, 'user:pay-a'),
      confirmSeat(T, circleId, 'user:pay-b'),
    ]);
    expect(race.arrivals(), 'the race was not forced').toBe(4);

    const granted = results.filter((r) => r.granted).length;
    expect(granted).toBe(1);
    expect(results.some((r) => r.reason === 'cohort-full')).toBe(true);

    const detail = await getCohortDetail(T, circleId);
    expect(detail!.seatsTaken).toBeLessThanOrEqual(detail!.capacity);
    expect(detail!.seatsTaken).toBe(2);
  });
});

describe('seat saga repair (KTFULL-B12)', () => {
  it('recovers capacity stranded by an expiry that died before the decrement', async () => {
    const circleId = await cohort(5);
    await holdSeat(T, circleId, 'user:b1');
    await holdSeat(T, circleId, 'user:b2');
    expect((await getCohortDetail(T, circleId))?.seatsTaken).toBe(3); // coach + 2

    // The crash: both hold rows are gone (deleted) but the decrements never
    // ran. Under the old arithmetic those two seats were stranded FOREVER —
    // no retry could recover them, because there was no delta left to apply.
    await holds.delete(`${T}::${circleId}::user:b1`);
    await holds.delete(`${T}::${circleId}::user:b2`);
    expect((await getCohortDetail(T, circleId))?.seatsTaken).toBe(3); // the strand

    expect((await reconcileSeats(T, circleId))?.seatsTaken).toBe(1); // just the coach
  });

  it('grants access BEFORE releasing the hold, so a crash never costs a paid buyer their seat', async () => {
    const circleId = await cohort(3);
    await holdSeat(T, circleId, 'user:payer');

    // The crash: the grant write dies mid-confirm. The buyer's hold must SURVIVE
    // (they keep their reserved seat for the retry) — deleting the hold first
    // would leave a paying buyer with no hold and no grant.
    const crash = crashNextGrantWrite(circleId, 'user:payer');
    await expect(confirmSeat(T, circleId, 'user:payer')).rejects.toThrow('injected: grant write crashed');
    expect(crash.fired()).toBe(true);
    restoreSpy?.();
    restoreSpy = null;
    expect(await holds.get(`${T}::${circleId}::user:payer`), 'the hold was released before access was granted').not.toBeNull();
    expect(await liveGrant(T, circleId, 'user:payer')).toBeNull();
    expect((await getCohortDetail(T, circleId))?.seatsTaken).toBe(2); // coach + the held seat

    // The retry (a redelivered webhook) completes.
    expect((await confirmSeat(T, circleId, 'user:payer')).granted).toBe(true);

    // The hold is consumed and the buyer is a member — one occupant, not two.
    expect(await holds.get(`${T}::${circleId}::user:payer`)).toBeNull();
    expect((await getCohortDetail(T, circleId))?.seatsTaken).toBe(2); // coach + payer

    // The worst partial state the NEW order can produce: the grant landed but
    // the hold delete did not. Reconcile must count ONE occupant, not two —
    // the hold and the grant are the same person.
    await holds.put({
      tenantId: T, circleId, buyerSubject: 'user:payer',
      heldAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SEAT_HOLD_TTL_MS).toISOString(),
    });
    expect((await reconcileSeats(T, circleId))?.seatsTaken).toBe(2);
  });

  it('is idempotent — reconciling a healthy cohort changes nothing', async () => {
    const circleId = await cohort(4);
    await holdSeat(T, circleId, 'user:h1');
    await joinCohort(circleId, await invited('user:member', circleId));

    const first = await reconcileSeats(T, circleId);
    expect(first?.seatsTaken).toBe(3); // coach + holder + member
    const second = await reconcileSeats(T, circleId);
    expect(second?.seatsTaken).toBe(3);
  });

  // ARCH-C2 — a GRANT is not a SEAT. The first B12 fix derived occupancy from
  // the grant list, so an invitee who accepts through the generic accept route
  // (a coach, say) was counted as occupying a seat they never claimed — the
  // repair function shrank the cohort. Occupancy is now the intersection of a
  // seat claim and live access.
  // TWIN: kicktodo-data-integrity.test.ts "does NOT count a coach" (PROBE-KT5).
  it('does not count a grant-holder who never claimed a seat', async () => {
    const circleId = await cohort(4);
    await inviteToCircle(T, circleId, COACH, 'user:coach2', ['coach-plan-proposal']);
    await acceptGrant(circleId, 'user:coach2'); // active grant, NO claimSeat

    expect((await reconcileSeats(T, circleId))?.seatsTaken).toBe(1); // the owner alone
  });

  // TWIN (adjacent): kicktodo-data-integrity.test.ts KTD-14 "drops a subject whose grant
  // was revoked OUT OF BAND" — that one drives `releaseRevokedSeat`; this one `reconcileSeats` alone.
  it('does not double-count a revoked grant left behind by a failed refund', async () => {
    const circleId = await cohort(4);
    await holdSeat(T, circleId, 'user:refunded');
    await confirmSeat(T, circleId, 'user:refunded');
    expect((await getCohortDetail(T, circleId))?.seatsTaken).toBe(2);

    // The refund revoked the grant but died before restating the count — and
    // it bypassed `releaseSeat`, so the SEAT ROW is still there. Deriving from
    // seat rows alone would keep charging it; the intersection with live
    // access is what frees it.
    await revokeGrant(T, circleId, COACH, 'user:refunded');
    expect((await getCohortDetail(T, circleId))?.seatsTaken).toBe(2); // the strand

    expect((await reconcileSeats(T, circleId))?.seatsTaken).toBe(1);
  });
});
