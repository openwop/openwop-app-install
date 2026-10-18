/**
 * Grade-data 2026-10-14 (KickTodo distribution, DATA-ASSESSMENT.md) — the entitlement
 * lifecycle must follow the ORDER, not the product's current link, and must not be
 * undone by reconciliation after a DSAR.
 *
 *  - KTCOM-D1: a refund after the product was unlinked, or relinked to a different
 *    challenge with `replace`, used to leave the refunded buyer's access active
 *    forever (revoke resolved `productId → current link`, found nothing or the wrong
 *    challenge, and reconcile used the same lookup).
 *  - KTCOM-D2: after `eraseSubjectEntitlements` anonymized the row, the next
 *    `reconcileEntitlements` sweep re-granted it under the ORIGINAL subject, because
 *    Commerce keeps `order.createdBy`. A purchase made after the erasure still grants.
 *
 * Every case runs through the real Commerce order lifecycle and the real observers.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import {
  createOrder, createProduct, markAsPaid, refundOrder,
  registerOrderPaidObserver, registerOrderRefundObserver,
} from '../src/features/commerce/commerceService.js';
import {
  eraseSubjectEntitlements, getEntitlement, linkChallengeProduct, listEntitlementsFor,
  reconcileEntitlements, reprocessOrder, unlinkChallengeProduct,
} from '../src/features/kicktodo-commerce/entitlementService.js';

const ORG = 'org-kt-ent-lifecycle';
const BUYER = 'user:ent-lifecycle-buyer';
/** Mirror of the eraser's deterministic anonymized key (kept in sync with entitlementService). */
const anonOf = (tenantId: string, subject: string): string =>
  `erased:${createHash('sha256').update(`${tenantId}::${subject}`).digest('hex').slice(0, 24)}`;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  registerOrderPaidObserver(async (o) => void (await reprocessOrder(o, 'grant')));
  registerOrderRefundObserver(async (o) => void (await reprocessOrder(o, 'revoke')));
});

async function published(T: string, title: string): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

async function paidOrder(T: string, productId: string, ref: string): Promise<string> {
  const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId, quantity: 1 }] });
  await markAsPaid(T, ORG, order.orderId, ref);
  return order.orderId;
}

async function sellable(T: string, challengeId: string, name: string): Promise<string> {
  const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:publisher', type: 'digital', name, price: 19 });
  await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:publisher');
  return product.productId;
}

describe('KTCOM-D1 — a refund revokes what THIS order granted, whatever the link says now', () => {
  it('revokes after the product was unlinked', async () => {
    const T = 'tenant-kt-ent-unlink';
    const challengeId = await published(T, 'Unlinked Course');
    const productId = await sellable(T, challengeId, 'Unlinked Course');
    const orderId = await paidOrder(T, productId, 'demo:pi-unlink');
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('active');

    expect(await unlinkChallengeProduct(T, productId)).toBe(true);
    await refundOrder(T, ORG, orderId, { actor: 'user:operator' });

    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('revoked');
    // Reconcile agrees and converges.
    expect((await reconcileEntitlements(T)).entitlementsRepaired).toBe(0);
  });

  it('revokes the ORIGINAL challenge after a replace-relink, and never touches the new one', async () => {
    const T = 'tenant-kt-ent-relink';
    const first = await published(T, 'First Course');
    const second = await published(T, 'Second Course');
    const productId = await sellable(T, first, 'Relinked Course');
    const orderId = await paidOrder(T, productId, 'demo:pi-relink');
    expect((await getEntitlement(T, BUYER, first, 1))?.state).toBe('active');

    await linkChallengeProduct(T, productId, second, 1, 'user:publisher'); // the `replace` overwrite
    await refundOrder(T, ORG, orderId, { actor: 'user:operator' });

    expect((await getEntitlement(T, BUYER, first, 1))?.state).toBe('revoked');
    expect(await getEntitlement(T, BUYER, second, 1)).toBeNull();
  });

  it('a refund of an OLDER order still cannot claw back a newer purchase', async () => {
    const T = 'tenant-kt-ent-repurchase';
    const challengeId = await published(T, 'Repurchased Course');
    const productId = await sellable(T, challengeId, 'Repurchased Course');
    const older = await paidOrder(T, productId, 'demo:pi-old');
    await new Promise((r) => setTimeout(r, 5));
    const newer = await paidOrder(T, productId, 'demo:pi-new');
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.orderId).toBe(newer);

    await refundOrder(T, ORG, older, { actor: 'user:operator' });
    expect((await getEntitlement(T, BUYER, challengeId, 1))).toMatchObject({ state: 'active', orderId: newer });
  });
});

describe('KTCOM-D2 — reconciliation does not undo a DSAR', () => {
  it('does not re-grant an erased buyer\'s entitlement, but a later purchase still grants', async () => {
    const T = 'tenant-kt-ent-erased';
    const challengeId = await published(T, 'Erased Course');
    const productId = await sellable(T, challengeId, 'Erased Course');
    await paidOrder(T, productId, 'demo:pi-erased');
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('active');

    expect(await eraseSubjectEntitlements(T, BUYER)).toBe(1);
    expect(await getEntitlement(T, BUYER, challengeId, 1)).toBeNull();

    // The sweep sees the paid order (Commerce keeps `createdBy`) and must leave it.
    const sweep = await reconcileEntitlements(T);
    expect(sweep.entitlementsRepaired).toBe(0);
    expect(await getEntitlement(T, BUYER, challengeId, 1)).toBeNull();
    expect(await listEntitlementsFor(T, BUYER)).toHaveLength(0);

    // A NEW purchase after the erasure is a new fact and grants normally.
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await paidOrder(T, productId, 'demo:pi-after-erasure');
    expect(await getEntitlement(T, BUYER, challengeId, 1)).toMatchObject({ state: 'active', orderId: fresh });
  });

  it('a refund still revokes the anonymized row (money truth follows its order)', async () => {
    const T = 'tenant-kt-ent-erased-refund';
    const challengeId = await published(T, 'Erased Refund Course');
    const productId = await sellable(T, challengeId, 'Erased Refund Course');
    const orderId = await paidOrder(T, productId, 'demo:pi-erased-refund');
    await eraseSubjectEntitlements(T, BUYER);

    await refundOrder(T, ORG, orderId, { actor: 'user:operator' });
    const [tomb] = await listEntitlementsFor(T, anonOf(T, BUYER));
    expect(tomb).toMatchObject({ orderId, state: 'revoked' });
    await reconcileEntitlements(T);
    expect(await listEntitlementsFor(T, BUYER)).toHaveLength(0); // still nothing under the erased subject
  });
});
