/**
 * KTFULL-B13 — paid-order fulfilment must be REPAIRABLE, not merely
 * best-effort.
 *
 * Commerce invokes fulfilment observers best-effort: `notifyObservers` catches
 * and logs an adapter throw so the money truth never depends on fulfilment.
 * That ordering is right, but until now there was no path back — a paid order
 * whose observer failed once lacked its challenge entitlement permanently, and
 * the buyer would be told to "complete checkout" for something they had
 * already paid for.
 *
 * This file registers ONLY a FAILING paid observer (the registry is
 * module-scoped, so this file's wiring is its own), which reproduces the
 * strand exactly rather than simulating it, then proves `reconcileEntitlements`
 * recovers it.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards, registerEnrollGuard, EnrollDeniedError } from '../src/features/kicktodo-core/enrollmentService.js';
import {
  createOrder, createProduct, markAsPaid, refundOrder,
  registerOrderPaidObserver, registerOrderRefundObserver,
} from '../src/features/commerce/commerceService.js';
import {
  enrollGuardVerdict, getEntitlement, linkChallengeProduct, reconcileEntitlements, reprocessOrder,
} from '../src/features/kicktodo-commerce/entitlementService.js';

const ORG = 'org-kt-reconcile';
const BUYER = 'user:stranded-buyer';

/** Module-level switch read by the registered observers. Reset before EVERY case
 *  (and restored in `finally` where a case flips it) so case order never matters. */
let observerShouldFail = true;
beforeEach(() => { observerShouldFail = true; });

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  registerEnrollGuard(async ({ tenantId, ownerSubject, challenge }) =>
    enrollGuardVerdict({ tenantId, ownerSubject, challenge: { id: challenge.id, version: challenge.version } }),
  );
  // The REAL adapter, with a switch that makes it fail the way a downed
  // dependency would. Commerce swallows the throw by design.
  registerOrderPaidObserver(async (o) => {
    if (observerShouldFail) throw new Error('fulfilment adapter is down');
    await reprocessOrder(o, 'grant');
  });
  registerOrderRefundObserver(async (o) => {
    if (observerShouldFail) throw new Error('fulfilment adapter is down');
    await reprocessOrder(o, 'revoke');
  });
});

async function published(T: string, title: string): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

describe('entitlement reconciliation (KTFULL-B13)', () => {
  it('recovers a paid order the fulfilment observer failed to fulfil', async () => {
    const T = 'tenant-kt-reconcile-paid'; // own tenant: the sweep counts are exact
    const challengeId = await published(T, 'Stranded Course');
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:publisher', type: 'digital', name: 'Stranded Course', price: 19 });
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:publisher');

    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId: product.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-strand');

    // The money moved; the fulfilment did NOT. This is the stranded state —
    // the buyer has paid and is still locked out.
    expect(await getEntitlement(T, BUYER, challengeId, 1)).toBeNull();
    await expect(enroll({ tenantId: T, ownerSubject: BUYER, challengeId, challengeVersion: 1 }))
      .rejects.toBeInstanceOf(EnrollDeniedError);
    await expect(enroll({ tenantId: T, ownerSubject: BUYER, challengeId, challengeVersion: 1 }))
      .rejects.toThrow('This challenge requires a purchase. Complete checkout to enroll.');

    // Reconciliation repairs it.
    const first = await reconcileEntitlements(T);
    expect(first).toEqual({ ordersScanned: 1, entitlementsRepaired: 1 });
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('active');

    // The buyer can now enroll with what they paid for.
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: BUYER, challengeId, challengeVersion: 1 });
    expect(enrollment.state).toBe('active');

    // Idempotent — a healthy tenant repairs NOTHING, so the count is a real
    // signal rather than a restatement of order volume.
    const second = await reconcileEntitlements(T);
    expect(second).toEqual({ ordersScanned: 1, entitlementsRepaired: 0 });
  });

  it('also recovers a refund the observer failed to apply', async () => {
    const T = 'tenant-kt-reconcile-refund';
    const challengeId = await published(T, 'Refunded Course');
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:publisher', type: 'digital', name: 'Refunded Course', price: 19 });
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:publisher');

    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId: product.productId, quantity: 1 }] });
    // Let this one fulfil normally so there is an active entitlement to revoke.
    observerShouldFail = false;
    try {
      await markAsPaid(T, ORG, order.orderId, 'demo:pi-refund');
    } finally {
      observerShouldFail = true;
    }
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('active');

    // Now the refund observer fails — access stays granted after a refund.
    await refundOrder(T, ORG, order.orderId, { actor: 'user:operator' });
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('active'); // the strand

    expect(await reconcileEntitlements(T)).toEqual({ ordersScanned: 1, entitlementsRepaired: 1 });
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('revoked');
  });
});
