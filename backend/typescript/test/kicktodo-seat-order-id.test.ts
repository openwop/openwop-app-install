/**
 * KTCOM-4 (KickTodo wave 4C) — a cohort seat remembers the order that bought it.
 *
 * Before: the seat ledger row had no `orderId`, so a refund resolved the cohort
 * through the product's CURRENT link and released the buyer's seat whichever of
 * their orders was refunded — refunding a redundant second order took away the
 * seat the first order paid for. And the operator `/reconcile` repaired
 * entitlements and shares but never seats.
 *
 * Now: `confirmSeat` records the order on the seat; a refund releases only the
 * seat its own order bought (a seat from before KTCOM-4 records none and keeps the
 * old behaviour); `reconcileSeatOrders` re-derives seat effects from the tenant's
 * terminal orders, without ever undoing an owner's revocation.
 *
 * What breaks these (sabotage-witnessed, each reverted and restored):
 *  - drop the `seat.orderId !== opts.orderId` refusal in `releaseSeat` → the
 *    redundant-refund case releases the paid seat;
 *  - stop passing `{ orderId }` from `reprocessSeatOrder` → same;
 *  - drop the `grantRowExists` guard in `reconcileSeatOrders` → the revoked
 *    buyer is re-seated;
 *  - drop the `reconcileSeatOrders` refund sweep → the stranded refund keeps its seat.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { createCircle, liveGrant, revokeGrant } from '../src/features/kicktodo-accountability/circleService.js';
import { createCohortDetail } from '../src/features/kicktodo-accountability/cohortService.js';
import { linkCohortProduct, reconcileSeatOrders, reprocessSeatOrder } from '../src/features/kicktodo-commerce/seatService.js';
import type { Order, OrderStatus } from '../src/features/commerce/commerceService.js';

const COACH = 'user:seat-oid-coach';
const ORG = 'org-seat-oid';
const PRODUCT = 'prod-seat-oid';
const NOW = new Date('2098-06-01T00:00:00.000Z'); // before the 2099 cohort start
let T = '';
let n = 0;

const orderRows = () => new DurableCollection<Order>('commerce:order', (o) => o.orderId, undefined, (o) => o.tenantId);
const order = (orderId: string, buyer: string, status: OrderStatus = 'paid'): Order => ({
  orderId, tenantId: T, orgId: ORG,
  items: [{ productId: PRODUCT, name: 'Seat', unitPrice: 10, quantity: 1 }],
  subtotal: 10, discount: 0, total: 10, currency: 'usd',
  status, fulfillmentStatus: 'pending',
  createdBy: buyer, createdAt: '2098-05-01T00:00:00.000Z', updatedAt: '2098-05-01T00:00:00.000Z',
});

let circleId = '';
beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  n += 1;
  T = `tenant-seat-oid-${n}`;
  const draft = await createDraft({
    tenantId: T, title: 'Coached', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: COACH, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: enrollment.id, ownerSubject: COACH, name: 'Cohort' });
  await createCohortDetail({ circle, actorSubject: COACH, capacity: 5, startDateLocal: '2099-01-01' });
  circleId = circle.id;
  await linkCohortProduct(T, COACH, { productId: PRODUCT, circleId });
});

describe('KTCOM-4 — a refund releases only the seat its own order bought', () => {
  it('refunding a redundant second order keeps the seat the first order paid for', async () => {
    expect(await reprocessSeatOrder(order('ord-1', 'user:buyer'), 'grant')).toBe(1);
    expect(await reprocessSeatOrder(order('ord-2', 'user:buyer'), 'grant')).toBe(1); // already a member
    expect(await reprocessSeatOrder(order('ord-2', 'user:buyer', 'refunded'), 'revoke')).toBe(0);
    expect(await liveGrant(T, circleId, 'user:buyer')).not.toBeNull();
    // The order that bought the seat still releases it.
    expect(await reprocessSeatOrder(order('ord-1', 'user:buyer', 'refunded'), 'revoke')).toBe(1);
    expect(await liveGrant(T, circleId, 'user:buyer')).toBeNull();
  });
});

describe('KTCOM-4 — /reconcile repairs seats from the tenant\'s orders', () => {
  it('seats a paid buyer the observer never reached, releases a stranded refund, and is idempotent', async () => {
    // A paid order whose observer never ran.
    await orderRows().put(order('ord-missed', 'user:missed'));
    // A seat whose refund observer never ran.
    expect(await reprocessSeatOrder(order('ord-stranded', 'user:stranded'), 'grant')).toBe(1);
    await orderRows().put(order('ord-stranded', 'user:stranded', 'refunded'));

    expect(await reconcileSeatOrders(T, NOW)).toEqual({ seatsRepaired: 2 });
    expect(await liveGrant(T, circleId, 'user:missed')).not.toBeNull();
    expect(await liveGrant(T, circleId, 'user:stranded')).toBeNull();
    expect(await reconcileSeatOrders(T, NOW)).toEqual({ seatsRepaired: 0 });
  });

  it('never re-seats a paid buyer the owner revoked', async () => {
    await orderRows().put(order('ord-kicked', 'user:kicked'));
    expect(await reprocessSeatOrder(order('ord-kicked', 'user:kicked'), 'grant')).toBe(1);
    await revokeGrant(T, circleId, COACH, 'user:kicked');
    expect(await reconcileSeatOrders(T, NOW)).toEqual({ seatsRepaired: 0 });
    expect(await liveGrant(T, circleId, 'user:kicked')).toBeNull();
  });
});
