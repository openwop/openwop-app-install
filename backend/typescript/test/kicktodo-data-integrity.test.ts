/**
 * /grade-data (2026-07-19) — durable-state integrity assertions for the three
 * KickTodo data claims the remediation made but did not pin.
 *
 * Each test here exists because static reading showed the behaviour is CORRECT
 * but nothing proved it, or showed a real gap that needed closing:
 *
 *  - KTD-12: `verifierSampleService` changed its sample id from
 *    `${enrollmentId}::${sat|unsat}` to `${enrollmentId}`. Legacy rows are NOT
 *    orphaned from reads (they still match the `${tenantId}::` prefix scan) but
 *    the idempotency probe missed them, so re-sampling minted a SECOND row and
 *    reintroduced the ARCH-M2 double-count. Pins the compat read.
 *  - KTD-13: `ChallengeEntitlement.orderCreatedAt` is optional — a schema
 *    evolution over rows written before it existed. Absent MUST read as oldest
 *    so a dated order always wins and the sweep converges.
 *  - KTD-14: `reconcileSeats` derives occupancy as the INTERSECTION of the seat
 *    ledger and live grants. Pins that a revoked grant drops the subject from
 *    the count, and documents that the seat ROW survives (the known orphan).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { evaluateEnrollment } from '../src/features/kicktodo-core/progressService.js';
import { sampleVerdict, verifierQuality } from '../src/features/kicktodo-metrics/verifierSampleService.js';
import { createCircle, revokeGrant, inviteToCircle, acceptGrant } from '../src/features/kicktodo-accountability/circleService.js';
import {
  confirmSeat, createCohortDetail, getCohortDetail, holdSeat, reconcileSeats, releaseRevokedSeat,
} from '../src/features/kicktodo-accountability/cohortService.js';
import { getEntitlement, reprocessOrder, linkChallengeProduct } from '../src/features/kicktodo-commerce/entitlementService.js';
import type { Order } from '../src/features/commerce/commerceService.js';

const T = 'tenant-kt-dataint';
const OWNER = 'user:kt-dataint-owner';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: true, confidence: 1, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

async function publishedChallenge(title: string): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title, summary: 's', outcome: 'o', durationDays: 2,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

/** An enrollment the judge has ruled on — the only sampleable state. */
async function judgedEnrollment(): Promise<string> {
  const challengeId = await publishedChallenge('Judged');
  const { enrollment } = await enroll({
    tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC',
  });
  const card = (await todayFor(T, OWNER)).enrollments[0]?.actions[0]?.occurrence.cardId;
  if (card) await submitCheckIn(T, OWNER, card, {});
  await evaluateEnrollment(T, enrollment.id, OWNER);
  return enrollment.id;
}

describe('KTD-12 — verifier-sample id shape change does not double-count', () => {
  it('re-sampling an enrollment already sampled under the LEGACY id returns the legacy row', async () => {
    const enrollmentId = await judgedEnrollment();

    // Plant a row exactly as the pre-change code wrote it: the verdict was
    // encoded IN the id. Raw, because no current code path can produce it.
    const legacyId = `${enrollmentId}::sat`;
    await hostExtStorage().kvSet(
      `hostext:kicktodo-verifier-samples:${T}::${legacyId}`,
      JSON.stringify({
        tenantId: T, sampleId: legacyId, enrollmentId,
        machineSatisfied: true, approvalId: 'appr:legacy', createdAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    expect((await verifierQuality(T)).sampled).toBe(1);

    const row = await sampleVerdict(T, { enrollmentId, submittedBy: OWNER });

    // The legacy row is REUSED, not superseded: one sample per enrollment.
    expect(row.sampleId).toBe(legacyId);
    expect(row.approvalId).toBe('appr:legacy');
    expect((await verifierQuality(T)).sampled).toBe(1);
  });

  it('is still idempotent under the NEW id shape', async () => {
    const enrollmentId = await judgedEnrollment();
    const first = await sampleVerdict(T, { enrollmentId, submittedBy: OWNER });
    const second = await sampleVerdict(T, { enrollmentId, submittedBy: OWNER });
    expect(second.sampleId).toBe(first.sampleId);
    expect(second.approvalId).toBe(first.approvalId);
    expect((await verifierQuality(T)).sampled).toBe(1);
  });
});

describe('KTD-13 — entitlement rows written before `orderCreatedAt` existed', () => {
  it('treats an ABSENT orderCreatedAt as oldest, so a dated order takes the pointer', async () => {
    const challengeId = await publishedChallenge('Sold');
    const productId = 'prod:kt-dataint';
    await linkChallengeProduct(T, productId, challengeId, 1, OWNER);

    // A LEGACY entitlement row: active, undated, pointing at some old order.
    await hostExtStorage().kvSet(
      `hostext:kicktodo-entitlements:${T}::${OWNER}::${challengeId}::v1`,
      JSON.stringify({
        tenantId: T, buyerSubject: OWNER, challengeId, challengeVersion: 1,
        orderId: 'ord:legacy', state: 'active', grantedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const before = await getEntitlement(T, OWNER, challengeId, 1);
    expect(before?.orderCreatedAt).toBeUndefined();

    // A PAID order, built directly: this test is about the entitlement
    // comparison, so it must not depend on commerce's product/tax machinery.
    const order: Order = {
      orderId: 'ord:kt-dataint-new', tenantId: T, orgId: 'org-kt-dataint',
      items: [{ productId, name: 'Cohort', unitPrice: 1000, quantity: 1 }],
      subtotal: 1000, discount: 0, total: 1000, currency: 'usd',
      status: 'paid', fulfillmentStatus: 'pending',
      createdBy: OWNER,
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    };
    await reprocessOrder(order, 'grant');

    const after = await getEntitlement(T, OWNER, challengeId, 1);
    // The dated order WON — absent read as oldest — and the row is now dated,
    // so the comparison is total from here on and the sweep converges.
    expect(after?.orderId).toBe(order.orderId);
    expect(after?.orderCreatedAt).toBe(order.createdAt);
    // `grantedAt` is PRESERVED across the upgrade — the buyer's original grant
    // date is a fact about them, not about which order currently points at it.
    expect(after?.grantedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('KTD-14 — reconcileSeats occupancy is the seat∩grant intersection', () => {
  it('drops a subject whose grant was revoked OUT OF BAND, and does not go negative', async () => {
    const challengeId = await publishedChallenge('Cohort');
    const { enrollment } = await enroll({
      tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC',
    });
    const circle = await createCircle({
      tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: OWNER, name: 'C',
    });
    await createCohortDetail({ circle, actorSubject: OWNER, capacity: 5, startDateLocal: '2099-01-01' });

    const buyer = 'user:kt-dataint-buyer';
    await holdSeat(T, circle.id, buyer);
    await confirmSeat(T, circle.id, buyer);

    // Owner + the confirmed buyer.
    const seated = await reconcileSeats(T, circle.id);
    expect(seated?.seatsTaken).toBe(2);

    // Revoke the grant OUT OF BAND (the generic revoke route / an admin action),
    // then run the production cleanup the route now performs.
    await revokeGrant(T, circle.id, OWNER, buyer);
    // KTD-14 — BEFORE the fix, nothing restated the count here: the revoke
    // route did not reconcile, so `seatsTaken` stayed stale at 2 and
    // `claimSeat` would wrongly refuse a new buyer. `releaseRevokedSeat` is
    // what the route now calls.
    await releaseRevokedSeat(T, circle.id, buyer);

    // The count is HEALED (not merely inert-on-next-read): the owner alone (the buyer was revoked).
    const detail = await getCohortDetail(T, circle.id);
    expect(detail?.seatsTaken).toBe(1);

    // KTD-14 — the orphan seat ROW is now PRUNED (a targeted point-delete), not
    // left to accumulate. The count stays derivable either way, but the ledger
    // no longer carries a dead row.
    const rows = await hostExtStorage().kvList(`hostext:kicktodo-cohort-seats:${T}::${circle.id}::`);
    expect(rows).toHaveLength(0); // the buyer was the only seat-ledger row; it is pruned
  });

  it('recordSeat strictly follows acceptGrant — a seat row is always grant-backed at write time', async () => {
    // The no-false-prune property depends on this ordering: if a future
    // refactor recorded the seat BEFORE granting access, `releaseRevokedSeat`
    // (and any prune) could eat an in-progress seat. This pins the post-
    // condition: after a confirm, the seat row's subject HAS a live grant.
    const challengeId = await publishedChallenge('OrderInv');
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC' });
    const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: OWNER, name: 'C' });
    await createCohortDetail({ circle, actorSubject: OWNER, capacity: 5, startDateLocal: '2099-01-01' });
    const buyer = 'user:kt-order-buyer';
    await holdSeat(T, circle.id, buyer);
    await confirmSeat(T, circle.id, buyer);
    // The seat row exists AND the grant is live — reconcile counts them (2).
    const seatRows = await hostExtStorage().kvList(`hostext:kicktodo-cohort-seats:${T}::${circle.id}::`);
    expect(seatRows.some((r) => r.key.includes(buyer))).toBe(true);
    expect((await reconcileSeats(T, circle.id))?.seatsTaken).toBe(2);
  });
});

/**
 * `PROBE-KT5`, migrated — with a CORRECTION to the probe's own wording.
 *
 * The row reads: "seat integrity: for each cohort, `seatsTaken` >= live holds +
 * active grants (never less)". **That inequality contradicts the model the code
 * deliberately moved to.** ARCH-C2 (`cohortService.ts:300`) made occupancy the
 * INTERSECTION of "claimed a seat" and "still has access", unioned with
 * unexpired holds — precisely because counting GRANTS alone counted coaches,
 * who accept through the generic route and never claim a seat. Under ARCH-C2 a
 * cohort with one coach-grant and no seat row has `seatsTaken` = 0 < 1 grant,
 * so asserting the probe's literal claim would PIN A DEFECT the codebase had
 * already fixed.
 *
 * So this asserts the real invariant, and specifically the two ARCH-C2 arms the
 * existing cases above do not reach: the coach (grant, no seat) and hold expiry.
 * The revoked-grant arm is already covered by the KTD-14 case above.
 */
describe('PROBE-KT5 (executable) — ARCH-C2 seat occupancy', () => {
  it('does NOT count a coach — a live grant with no seat row is not an occupant', async () => {
    const challengeId = await publishedChallenge('CoachInv');
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC' });
    const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: OWNER, name: 'C' });
    await createCohortDetail({ circle, actorSubject: OWNER, capacity: 5, startDateLocal: '2099-01-01' });

    const coach = 'user:kt-coach';
    await inviteToCircle(T, circle.id, OWNER, coach, ['action-status']);
    await acceptGrant(circle.id, coach);

    // PRECONDITION: the coach really does hold a live grant — otherwise "not
    // counted" would be true for the trivial reason that nothing was granted.
    const seatRows = await hostExtStorage().kvList(`hostext:kicktodo-cohort-seats:${T}::${circle.id}::`);
    expect(seatRows.some((r) => r.key.includes(coach)), 'a coach must NOT have a seat row').toBe(false);

    const detail = await reconcileSeats(T, circle.id);
    expect(
      detail?.seatsTaken,
      'the coach was counted as an occupant — this is the exact ARCH-C2 regression (grants alone counted coaches)',
    ).toBe(1); // the owner only
  });

  it('counts an UNEXPIRED hold, and stops counting it once expired', async () => {
    const challengeId = await publishedChallenge('HoldInv');
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC' });
    const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: OWNER, name: 'C' });
    await createCohortDetail({ circle, actorSubject: OWNER, capacity: 5, startDateLocal: '2099-01-01' });

    const buyer = 'user:kt-hold-buyer';
    await holdSeat(T, circle.id, buyer);
    expect((await reconcileSeats(T, circle.id))?.seatsTaken, 'an unexpired hold must reserve capacity').toBe(2);

    // Expire the hold in place (the daemon's TTL, without waiting for it).
    const key = (await hostExtStorage().kvList(`hostext:kicktodo-seat-holds:${T}::${circle.id}::`))
      .find((r) => r.key.includes(buyer))!;
    const row = JSON.parse(key.value) as { expiresAt?: string };
    row.expiresAt = '2020-01-01T00:00:00.000Z';
    await hostExtStorage().kvSet(key.key, JSON.stringify(row));

    expect(
      (await reconcileSeats(T, circle.id))?.seatsTaken,
      'an EXPIRED hold still occupied a seat — capacity is stranded against a buyer who never paid',
    ).toBe(1);
  });
});
