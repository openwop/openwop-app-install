/**
 * ADR 0420 P1 — the money adapter:
 *
 *  - a paid challenge gates NEW enrollment (402) until the buyer's order hits
 *    the CAS pending→paid transition (the fulfilment observer grants the
 *    entitlement — never the checkout return)
 *  - grant is idempotent per order; re-observing never duplicates
 *  - full refund REVOKES future access (new enrollment refused) while the
 *    EXISTING enrollment keeps converging (never stranded)
 *  - unlinked challenges stay free; entitlements are buyer-scoped reads
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import {
  enroll,
  getEnrollment,
  registerEnrollGuard,
  __clearEnrollGuards,
  EnrollDeniedError,
} from '../src/features/kicktodo-core/enrollmentService.js';
import {
  createProduct,
  createOrder,
  markAsPaid,
  refundOrder,
  registerOrderPaidObserver,
  registerOrderRefundObserver,
} from '../src/features/commerce/commerceService.js';
import {
  enrollGuardVerdict,
  getEntitlement,
  linkChallengeProduct,
  listEntitlementsFor,
  reprocessOrder,
} from '../src/features/kicktodo-commerce/entitlementService.js';

const T = 'tenant-kt-money';
const ORG = 'org-kt-money';
const BUYER = 'user:buyer';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  // The adapter's boot wiring (feature.registerRoutes does this in the app).
  __clearEnrollGuards();
  registerEnrollGuard(async ({ tenantId, ownerSubject, challenge }) =>
    enrollGuardVerdict({ tenantId, ownerSubject, challenge: { id: challenge.id, version: challenge.version } }),
  );
  registerOrderPaidObserver(async (o) => void (await reprocessOrder(o, 'grant')));
  registerOrderRefundObserver(async (o) => void (await reprocessOrder(o, 'revoke')));
});

async function publishedChallenge(title: string) {
  const draft = await createDraft({
    tenantId: T, title, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

describe('paid-challenge entitlement loop (ADR 0420 P1)', () => {
  it('402 before payment; observer grants on pending→paid; enroll succeeds; refund revokes future access only', async () => {
    const challengeId = await publishedChallenge('Paid Focus Course');
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: BUYER, type: 'digital', name: 'Paid Focus Course', price: 29 });
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:publisher');

    // Gated before purchase.
    await expect(enroll({ tenantId: T, ownerSubject: BUYER, challengeId, challengeVersion: 1 })).rejects.toBeInstanceOf(EnrollDeniedError);

    // Checkout → order → CAS pending→paid → the observer grants.
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId: product.productId, quantity: 1 }] });
    expect(await getEntitlement(T, BUYER, challengeId, 1)).toBeNull(); // NOT on checkout
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-1');
    const ent = await getEntitlement(T, BUYER, challengeId, 1);
    expect(ent?.state).toBe('active');
    expect(ent?.orderId).toBe(order.orderId);

    // Idempotent: re-observing the same order changes nothing.
    expect(await reprocessOrder({ ...order, status: 'paid' }, 'grant')).toBe(0);

    // Enroll now succeeds; the buyer's entitlement list shows the purchase.
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: BUYER, challengeId, challengeVersion: 1 });
    expect(enrollment.state).toBe('active');
    expect((await listEntitlementsFor(T, BUYER)).some((e) => e.orderId === order.orderId)).toBe(true);

    // Full refund → revoked; the EXISTING enrollment keeps converging…
    await refundOrder(T, ORG, order.orderId, { actor: 'user:operator' });
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('revoked');
    const again = await enroll({ tenantId: T, ownerSubject: BUYER, challengeId, challengeVersion: 1 });
    expect(again.enrollment.id).toBe(enrollment.id); // idempotent convergence, not a new enrollment
    expect((await getEnrollment(T, enrollment.id))?.state).toBe('active');

    // …but a DIFFERENT buyer without an entitlement is still refused.
    await expect(enroll({ tenantId: T, ownerSubject: 'user:freeloader', challengeId, challengeVersion: 1 })).rejects.toBeInstanceOf(EnrollDeniedError);
  });

  it('an unlinked challenge stays free', async () => {
    const freeId = await publishedChallenge('Free Starter');
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: 'user:anyone', challengeId: freeId, challengeVersion: 1 });
    expect(enrollment.state).toBe('active');
  });

  it('a refund of one order never claws back an entitlement granted by a later re-purchase', async () => {
    const challengeId = await publishedChallenge('Repurchase Course');
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: BUYER, type: 'digital', name: 'Repurchase', price: 9 });
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:publisher');

    const first = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId: product.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, first.orderId, 'demo:pi-2');
    // ARCH-H1 re-points only on a STRICTLY newer createdAt; on a fast run both
    // orders can land in the same millisecond and the guard (correctly) keeps
    // the first pointer. This test's claim needs a genuinely newer order —
    // own the precondition instead of racing the clock.
    await new Promise((r) => setTimeout(r, 2));
    const second = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId: product.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, second.orderId, 'demo:pi-3');
    // The second purchase RE-POINTS the entitlement to the newest paying
    // order, so the FIRST order's refund cannot claw it back.
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.orderId).toBe(second.orderId);
    await refundOrder(T, ORG, first.orderId, { actor: 'user:operator' });
    const ent = await getEntitlement(T, BUYER, challengeId, 1);
    expect(ent?.state).toBe('active');
    expect(ent?.orderId).toBe(second.orderId);
  });
});

describe('KickBot Plus tier gate (ADR 0420 P2)', () => {
  it('a limit caps ACTIVE enrollments; unlimited (null) never blocks; the denial names the upgrade path', async () => {
    const { enrollTierVerdict } = await import('../src/features/kicktodo-commerce/tierGuard.js');
    const T2 = 'tenant-tier';
    const who = 'user:tier-buyer';
    const a = await publishedChallengeIn(T2, 'Tier A');
    const b = await publishedChallengeIn(T2, 'Tier B');
    await enroll({ tenantId: T2, ownerSubject: who, challengeId: a, challengeVersion: 1 });

    // Limit 1 → the second enrollment is refused with actionable copy.
    const denied = await enrollTierVerdict({ tenantId: T2, ownerSubject: who }, async () => 1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain('KickBot Plus');

    // Limit 2 → allowed; unlimited (null) → allowed.
    expect((await enrollTierVerdict({ tenantId: T2, ownerSubject: who }, async () => 2)).ok).toBe(true);
    expect((await enrollTierVerdict({ tenantId: T2, ownerSubject: who }, async () => null)).ok).toBe(true);
    void b;
  });
});

async function publishedChallengeIn(tenantId: string, title: string) {
  const draft = await createDraft({
    tenantId, title, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(tenantId, draft.id, 1);
  return draft.id;
}

describe('challenge product type + revenue projection (ADR 0420 P3/P5)', () => {
  it('a challenge-typed product sells a challenge end-to-end; revenue counts are creator-scoped and PII-free', async () => {
    const challengeId = await publishedChallengeIn(T, 'Typed Challenge');
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:creator', type: 'challenge', name: 'Typed Challenge', price: 19 });
    expect(product.type).toBe('challenge');
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:creator');

    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'user:typed-buyer', lines: [{ productId: product.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-typed');
    expect((await getEntitlement(T, 'user:typed-buyer', challengeId, 1))?.state).toBe('active');

    const { revenueProjectionFor } = await import('../src/features/kicktodo-commerce/entitlementService.js');
    const revenue = await revenueProjectionFor(T, 'user:creator');
    const row = revenue.find((r) => r.challengeId === challengeId);
    expect(row?.activeEntitlements).toBe(1);
    expect(row?.revokedEntitlements).toBe(0);
    expect(JSON.stringify(revenue)).not.toContain('typed-buyer'); // counts only — no buyer PII
    // Another creator sees nothing of it.
    expect((await revenueProjectionFor(T, 'user:other-creator')).find((r) => r.challengeId === challengeId)).toBeUndefined();
  });
});
