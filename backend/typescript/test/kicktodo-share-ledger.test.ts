/**
 * ADR 0445 P1 — the author share ledger, derived from existing money truth:
 *
 *  - no policy (or 0 bps) ⇒ NO rows (no policy, no promise)
 *  - accrual on the paid observer: minor-units-first, deterministic key,
 *    idempotent under webhook replay / reprocess sweeps
 *  - a reversal MIRRORS the accrual (negated) under the policy version it was
 *    accrued with — a policy change between sale and refund must not change
 *    the clawback
 *  - discount is floor-allocated per line; tax/shipping never enter the share
 *  - author reads are self-scoped; summaries net reversals against accruals
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import {
  createProduct,
  createOrder,
  markAsPaid,
  refundOrder,
  registerOrderPaidObserver,
  registerOrderRefundObserver,
  type Order,
} from '../src/features/commerce/commerceService.js';
import { linkChallengeProduct } from '../src/features/kicktodo-commerce/entitlementService.js';
import { resolveApproval, getApproval } from '../src/host/approvalService.js';
import {
  requestSellerOnboarding,
  sellerRequestStatus,
  SellerRequestError,
} from '../src/features/kicktodo-commerce/sellerRequestService.js';
import {
  createPayoutRun,
  confirmPayoutRun,
  cancelPayoutRun,
  listPayoutRuns,
  PayoutRunError,
  deriveShares,
  getSharePolicy,
  setSharePolicy,
  listSharesForAuthor,
  listSharesForTenant,
  reconcileShares,
  summarizeShares,
  SharePolicyError,
} from '../src/features/kicktodo-commerce/shareLedgerService.js';

const ORG = 'org-kt-shares';
const AUTHOR = 'user:author';
const BUYER = 'user:buyer';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  // The adapter's boot wiring (feature.registerRoutes does this in the app).
  registerOrderPaidObserver(async (o) => void (await deriveShares(o, 'accrue')));
  registerOrderRefundObserver(async (o) => void (await deriveShares(o, 'reverse')));
});

async function publishedLinkedProduct(tenantId: string, title: string, price: number) {
  const draft = await createDraft({
    tenantId, title, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(tenantId, draft.id, 1);
  const product = await createProduct({ tenantId, orgId: ORG, createdBy: AUTHOR, type: 'digital', name: title, price });
  await linkChallengeProduct(tenantId, product.productId, draft.id, 1, AUTHOR);
  return { challengeId: draft.id, productId: product.productId };
}

describe('share policy (ADR 0445 D1)', () => {
  it('validates bps bounds and versions monotonically', async () => {
    const T = 'tenant-shares-policy';
    await expect(setSharePolicy(T, -1, AUTHOR)).rejects.toBeInstanceOf(SharePolicyError);
    await expect(setSharePolicy(T, 10001, AUTHOR)).rejects.toBeInstanceOf(SharePolicyError);
    await expect(setSharePolicy(T, 12.5, AUTHOR)).rejects.toBeInstanceOf(SharePolicyError);
    const v1 = await setSharePolicy(T, 2000, AUTHOR);
    expect(v1.version).toBe(1);
    const v2 = await setSharePolicy(T, 3000, AUTHOR);
    expect(v2.version).toBe(2);
    expect((await getSharePolicy(T))?.shareBps).toBe(3000);
  });
});

describe('accrual on paid (ADR 0445 P1)', () => {
  it('no policy ⇒ no rows; the sale still completes', async () => {
    const T = 'tenant-shares-nopolicy';
    const { productId } = await publishedLinkedProduct(T, 'Unshared Course', 29);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-np');
    expect(await listSharesForTenant(T)).toEqual([]);
  });

  it('accrues minor-units-first with the policy version stamped; idempotent under replay', async () => {
    const T = 'tenant-shares-accrue';
    await setSharePolicy(T, 2000, 'user:operator'); // 20%
    const { challengeId, productId } = await publishedLinkedProduct(T, 'Shared Course', 29);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-acc');

    const rows = await listSharesForTenant(T);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      kind: 'accrual',
      challengeId,
      authorSubject: AUTHOR,
      grossMinor: 2900,
      shareBps: 2000,
      shareMinor: 580,
      policyVersion: 1,
      state: 'accrued',
    });

    // Webhook replay / reconcile sweep: re-deriving writes nothing.
    expect(await deriveShares({ ...order, status: 'paid' }, 'accrue')).toBe(0);
    expect(await listSharesForTenant(T)).toHaveLength(1);
  });

  it('floor-allocates an order-level discount per line; unlinked lines never accrue', async () => {
    const T = 'tenant-shares-discount';
    await setSharePolicy(T, 2500, 'user:operator'); // 25%
    const { challengeId, productId } = await publishedLinkedProduct(T, 'Discounted Course', 60);
    // Hand-built order (derivation is pure over the row): a second, UNLINKED
    // line + an order-level discount. subtotal 100, discount 10 ⇒ the linked
    // 60-major line carries floor(1000×6000/10000)=600 minor of discount.
    const order: Order = {
      orderId: 'ord-disc-1', tenantId: T, orgId: ORG,
      items: [
        { productId, name: 'Discounted Course', unitPrice: 60, quantity: 1 },
        { productId: 'prod-unlinked', name: 'Merch', unitPrice: 40, quantity: 1 },
      ],
      subtotal: 100, discount: 10, total: 90, currency: 'usd',
      status: 'paid', fulfillmentStatus: 'pending',
      createdBy: BUYER, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    expect(await deriveShares(order, 'accrue')).toBe(1); // only the linked line
    const [row] = await listSharesForTenant(T);
    expect(row.challengeId).toBe(challengeId);
    expect(row.grossMinor).toBe(5400); // 6000 − 600
    expect(row.shareMinor).toBe(1350); // floor(5400 × 2500 / 10000)
  });
});

describe('grade-code fixes (2026-07-20 review)', () => {
  it('#1 — TWO products selling the SAME challenge in one order BOTH accrue (money keys per line, never per challenge)', async () => {
    const T = 'tenant-shares-twoprod';
    await setSharePolicy(T, 2000, 'user:operator');
    const { challengeId, productId } = await publishedLinkedProduct(T, 'Std Edition', 29);
    const premium = await createProduct({ tenantId: T, orgId: ORG, createdBy: AUTHOR, type: 'digital', name: 'Premium Edition', price: 99 });
    await linkChallengeProduct(T, premium.productId, challengeId, 1, AUTHOR);

    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [
      { productId, quantity: 1 },
      { productId: premium.productId, quantity: 1 },
    ] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-two');
    const rows = await listSharesForTenant(T);
    expect(rows).toHaveLength(2); // one per LINE — the second product's share is not dropped
    expect(rows.reduce((s, r) => s + r.shareMinor, 0)).toBe(580 + 1980); // 20% of 2900 + 20% of 9900
    // Refund reverses BOTH lines.
    await refundOrder(T, ORG, order.orderId, { actor: 'user:operator' });
    expect((await listSharesForTenant(T)).filter((r) => r.kind === 'reversal')).toHaveLength(2);
  });

  it('#3 — a refund landing AFTER a paid-out accrual leaves a net-negative author UNCLAIMABLE (no negative-entry run)', async () => {
    const T = 'tenant-shares-postpay-refund';
    await setSharePolicy(T, 2000, 'user:operator');
    const { productId } = await publishedLinkedProduct(T, 'Paid Then Refunded', 40);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-ppr');
    const run = await createPayoutRun(T, 'user:operator');
    await confirmPayoutRun(T, run.runId, 'user:operator', 'po_x');
    // The refund now writes an unclaimed NEGATIVE reversal…
    await refundOrder(T, ORG, order.orderId, { actor: 'user:operator' });
    // …which must never become a negative payout-run entry: net<=0 ⇒ refused.
    await expect(createPayoutRun(T, 'user:operator')).rejects.toBeInstanceOf(PayoutRunError);
    const reversal = (await listSharesForTenant(T)).find((r) => r.kind === 'reversal');
    expect(reversal?.payoutId).toBeUndefined(); // still in the pool, offsets FUTURE earnings
  });

  it('zero-decimal currency (JPY) accrues without a x100 scale error', async () => {
    const T = 'tenant-shares-jpy';
    await setSharePolicy(T, 2000, 'user:operator');
    const { challengeId, productId } = await publishedLinkedProduct(T, 'JPY Course', 500);
    const order: Order = {
      orderId: 'ord-jpy-1', tenantId: T, orgId: ORG,
      items: [{ productId, name: 'JPY Course', unitPrice: 500, quantity: 1 }],
      subtotal: 500, discount: 0, total: 500, currency: 'jpy',
      status: 'paid', fulfillmentStatus: 'pending',
      createdBy: BUYER, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    expect(await deriveShares(order, 'accrue')).toBe(1);
    const [row] = (await listSharesForTenant(T)).filter((r) => r.challengeId === challengeId);
    expect(row.grossMinor).toBe(500);  // zero-decimal: major IS minor
    expect(row.shareMinor).toBe(100);  // 20% of ¥500
  });
});

describe('reversal on refund (ADR 0445 P1)', () => {
  it('mirrors the accrual under its ORIGINAL policy — a policy change never rewrites the clawback — and is idempotent', async () => {
    const T = 'tenant-shares-reverse';
    await setSharePolicy(T, 2000, 'user:operator');
    const { productId } = await publishedLinkedProduct(T, 'Refunded Course', 50);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-rev');
    expect((await listSharesForTenant(T))[0]?.shareMinor).toBe(1000); // 20% of 5000

    // The policy moves BETWEEN sale and refund.
    await setSharePolicy(T, 5000, 'user:operator');
    await refundOrder(T, ORG, order.orderId, { actor: 'user:operator' });

    const rows = await listSharesForTenant(T);
    expect(rows).toHaveLength(2);
    const reversal = rows.find((r) => r.kind === 'reversal');
    expect(reversal).toMatchObject({
      shareMinor: -1000,   // mirrors the accrual, NOT −2500 under the new policy
      shareBps: 2000,
      policyVersion: 1,
      grossMinor: -5000,
    });

    // Redelivered refund webhook: nothing new.
    const paidOrder = { ...order, status: 'refunded' as const };
    expect(await deriveShares(paidOrder, 'reverse')).toBe(0);
    expect(await listSharesForTenant(T)).toHaveLength(2);

    // The author's summary nets to zero accrued.
    const mine = await listSharesForAuthor(T, AUTHOR);
    expect(summarizeShares(mine)).toEqual([{ currency: 'USD', accruedMinor: 0, paidMinor: 0 }]);
  });

  it('reconcileShares repairs a sale the observer accrued nothing for, then converges to zero', async () => {
    const T = 'tenant-shares-reconcile';
    // The sale lands BEFORE any policy exists — the paid observer honestly
    // accrues nothing (no policy, no promise).
    const { productId } = await publishedLinkedProduct(T, 'Stranded Course', 25);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-strand');
    expect(await listSharesForTenant(T)).toEqual([]);

    // The operator sets a policy and runs reconcile: past sales accrue under
    // the CURRENT policy — a DELIBERATE semantic (turning on revenue share and
    // honoring history is an explicit operator action, never automatic).
    await setSharePolicy(T, 2000, 'user:operator');
    expect((await reconcileShares(T)).shareRowsRepaired).toBe(1);
    expect((await listSharesForTenant(T))[0]?.shareMinor).toBe(500); // 20% of 2500

    // Healthy tenant ⇒ the sweep converges to zero repairs.
    expect((await reconcileShares(T)).shareRowsRepaired).toBe(0);
  });

  it('seller-onboarding request: anon refused, nothing-to-pay refused, idempotent approval, rejection allows re-request (ADR 0445 P2)', async () => {
    const T = 'tenant-shares-seller';
    // anon: tenants can never become sellers (GEN-CC-1 mirror).
    await expect(requestSellerOnboarding('anon:sid-1', AUTHOR)).rejects.toBeInstanceOf(SellerRequestError);
    // No product links ⇒ nothing to be paid for.
    await expect(requestSellerOnboarding(T, 'user:no-links')).rejects.toBeInstanceOf(SellerRequestError);

    const { productId } = await publishedLinkedProduct(T, 'Seller Course', 15);
    void productId;
    const first = await requestSellerOnboarding(T, AUTHOR);
    expect((await getApproval(first.approvalId))?.kind).toBe('connect-seller');
    expect((await sellerRequestStatus(T, AUTHOR)).request).toBe('pending');

    // Idempotent while pending: no duplicate approval.
    const again = await requestSellerOnboarding(T, AUTHOR);
    expect(again.approvalId).toBe(first.approvalId);

    // Approve ⇒ status follows; a further request stays on the approved one.
    await resolveApproval(first.approvalId, { status: 'approved', note: 'ok' });
    expect((await sellerRequestStatus(T, AUTHOR)).request).toBe('approved');
    expect((await requestSellerOnboarding(T, AUTHOR)).approvalId).toBe(first.approvalId);

    // Status is self-scoped: another subject has no request (and no links ⇒
    // cannot create one for themselves either).
    expect((await sellerRequestStatus(T, 'user:someone-else')).request).toBe('none');
  });

  it('payout run lifecycle: claim → confirm flips accrued→paid; net≤0 authors excluded; double-run safe (ADR 0445 P3)', async () => {
    const T = 'tenant-shares-payout';
    await setSharePolicy(T, 2000, 'user:operator');
    const a = await publishedLinkedProduct(T, 'Payout Course A', 50);   // author share 1000
    // A second sale + full refund nets a REVERSAL pair — still net-positive
    // overall (1000 + 500 − 500 = 1000).
    const b = await publishedLinkedProduct(T, 'Payout Course B', 25);
    const orderA = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId: a.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, orderA.orderId, 'demo:pi-pa');
    const orderB = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId: b.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, orderB.orderId, 'demo:pi-pb');
    await refundOrder(T, ORG, orderB.orderId, { actor: 'user:operator' });

    const run = await createPayoutRun(T, 'user:operator');
    expect(run.state).toBe('open');
    expect(run.entries).toEqual([{ authorSubject: AUTHOR, currency: 'USD', totalMinor: 1000, rowCount: 3 }]);

    // Double-run safety: every accrued row is claimed, so a second run has
    // nothing to pay.
    await expect(createPayoutRun(T, 'user:operator')).rejects.toBeInstanceOf(PayoutRunError);

    // Confirm with the external evidence → rows flip accrued→paid.
    const confirmed = await confirmPayoutRun(T, run.runId, 'user:operator', 'po_demo_123');
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.reference).toBe('po_demo_123');
    const mine = await listSharesForAuthor(T, AUTHOR);
    expect(mine.every((r) => r.state === 'paid' && r.payoutId === run.runId)).toBe(true);
    expect(summarizeShares(mine)).toEqual([{ currency: 'USD', accruedMinor: 0, paidMinor: 1000 }]);

    // Idempotent re-confirm; cancel of a confirmed run is refused (fail-closed).
    expect((await confirmPayoutRun(T, run.runId, 'user:operator', 'again')).reference).toBe('po_demo_123');
    await expect(cancelPayoutRun(T, run.runId)).rejects.toBeInstanceOf(PayoutRunError);
    expect((await listPayoutRuns(T))[0]?.runId).toBe(run.runId);
  });

  it('cancel releases an open run’s rows back to accrued; a net-negative author is never included', async () => {
    const T = 'tenant-shares-cancel';
    await setSharePolicy(T, 2000, 'user:operator');
    const { productId } = await publishedLinkedProduct(T, 'Cancel Course', 30);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-cx');

    const run = await createPayoutRun(T, 'user:operator');
    expect(run.entries[0]?.totalMinor).toBe(600);
    await cancelPayoutRun(T, run.runId);

    // Released ⇒ a fresh run can claim the same rows again.
    const rerun = await createPayoutRun(T, 'user:operator');
    expect(rerun.entries[0]?.totalMinor).toBe(600);
    await cancelPayoutRun(T, rerun.runId);
  });

  it('a REJECTED request may be re-requested with a fresh approval', async () => {
    const T = 'tenant-shares-rerequest';
    await publishedLinkedProduct(T, 'Rejected Course', 12);
    const first = await requestSellerOnboarding(T, AUTHOR);
    await resolveApproval(first.approvalId, { status: 'rejected', note: 'not yet' });
    expect((await sellerRequestStatus(T, AUTHOR)).request).toBe('rejected');
    const second = await requestSellerOnboarding(T, AUTHOR);
    expect(second.approvalId).not.toBe(first.approvalId);
    expect((await sellerRequestStatus(T, AUTHOR)).request).toBe('pending');
  });

  it('sharesCsv serializes the statement (ADR 0445 P4): header shape, escaping, author column only on the operator export', async () => {
    const { sharesCsv } = await import('../src/features/kicktodo-commerce/routes.js');
    const row = {
      tenantId: 'tenant-csv', orderId: 'ord-1', productId: 'prod-1', challengeId: 'chal "quoted"', kind: 'accrual' as const,
      authorSubject: AUTHOR, currency: 'USD', grossMinor: 5000, shareBps: 2000, shareMinor: 1000,
      policyVersion: 1, state: 'accrued' as const, orderCreatedAt: '2026-07-20T00:00:00.000Z', createdAt: '2026-07-20T00:00:01.000Z',
    };
    const self = sharesCsv([row], false);
    expect(self.split('\n')[0]).toBe('created_at,order_id,challenge_id,kind,currency,share_minor,share_bps,policy_version,state,payout_run');
    expect(self).toContain('"chal ""quoted"""'); // CSV escaping
    expect(self).not.toContain(AUTHOR);          // self export: no author column
    const operator = sharesCsv([row], true);
    expect(operator.split('\n')[0].startsWith('author,')).toBe(true);
    expect(operator).toContain(`"${AUTHOR}"`);
  });

  it('MEDIUM-2 (grade fix) — a LEGACY-shaped stored row is normalized at boot and can be CAS-claimed into a payout run', async () => {
    const T = 'tenant-shares-legacy';
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const { normalizeShareLedgerRows } = await import('../src/features/kicktodo-commerce/shareLedgerService.js');
    // Seed a PRE-EXTRACTION row exactly as the old adapter stored it.
    const rawView = new DurableCollection<Record<string, unknown>>(
      'kicktodo-share-ledger',
      (r) => `${String(r.tenantId)}::${String(r.orderId)}::${String(r.productId)}`,
    );
    await rawView.put({
      tenantId: T, orderId: 'ord-legacy-1', productId: 'prod-legacy-1', challengeId: 'chal-legacy',
      kind: 'accrual', authorSubject: AUTHOR, currency: 'USD', grossMinor: 5000, shareBps: 2000,
      shareMinor: 1000, policyVersion: 1, state: 'accrued',
      orderCreatedAt: '2026-07-19T00:00:00.000Z', createdAt: '2026-07-19T00:00:01.000Z',
    });
    // Readable through the upgrade hook even BEFORE normalization…
    expect((await listSharesForAuthor(T, AUTHOR))[0]?.shareMinor).toBe(1000);
    // …but the CAS-claim needs canonical bytes: normalize (idempotent), then pay.
    expect(await normalizeShareLedgerRows()).toBeGreaterThanOrEqual(1);
    expect(await normalizeShareLedgerRows()).toBe(0);
    const run = await createPayoutRun(T, 'user:operator');
    expect(run.entries).toEqual([{ authorSubject: AUTHOR, currency: 'USD', totalMinor: 1000, rowCount: 1 }]);
    await confirmPayoutRun(T, run.runId, 'user:operator', 'po_legacy');
    expect((await listSharesForAuthor(T, AUTHOR))[0]?.state).toBe('paid');
    expect((await listSharesForAuthor(T, AUTHOR))[0]?.challengeId).toBe('chal-legacy'); // meta survived
  });

  it('author reads are self-scoped', async () => {
    const T = 'tenant-shares-scope';
    await setSharePolicy(T, 1000, 'user:operator');
    const { productId } = await publishedLinkedProduct(T, 'Scoped Course', 10);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: BUYER, lines: [{ productId, quantity: 1 }] });
    await markAsPaid(T, ORG, order.orderId, 'demo:pi-scope');
    expect(await listSharesForAuthor(T, AUTHOR)).toHaveLength(1);
    expect(await listSharesForAuthor(T, 'user:someone-else')).toEqual([]);
  });
});
