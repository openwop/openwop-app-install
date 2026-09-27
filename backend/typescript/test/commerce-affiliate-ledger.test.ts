/**
 * ADR 0447 P2 — the affiliate lane on the obligation ledger. Pins the
 * capabilities the old running-balance model lacked (clawback, redelivery
 * idempotency, opening-balance backfill) and the preserved read contracts
 * (projected balanceOwed, the D2 export, 'No balance owed.' 409).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createAffiliate,
  accrueCommission,
  reverseCommission,
  recordPayout,
  listAffiliates,
  listPayouts,
  payoutExportRows,
  backfillAffiliateLedger,
  __resetAffiliates,
} from '../src/features/commerce/affiliate.js';

const T = 'tenant-affl';
const ORG = 'org-affl';
const at = (): string => new Date().toISOString();

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(async () => {
  await __resetAffiliates();
});

describe('accrual (per-order rows)', () => {
  it('a redelivered paid event accrues ONCE (first-write-wins by orderId)', async () => {
    await createAffiliate({ tenantId: T, orgId: ORG, code: 'REF10', commissionType: 'percentage', commissionRate: 10, currency: 'USD' });
    expect(await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-r1', createdAt: at(), total: 200, currency: 'USD', affiliateCode: 'REF10' })).toBe(20);
    expect(await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-r1', createdAt: at(), total: 200, currency: 'USD', affiliateCode: 'REF10' })).toBe(0); // redelivery
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(20);
  });

  it('fixed commissions convert minor-first (no float drift)', async () => {
    await createAffiliate({ tenantId: T, orgId: ORG, code: 'FLAT', commissionType: 'fixed', commissionRate: 7.5, currency: 'USD' });
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-f1', createdAt: at(), total: 10, currency: 'USD', affiliateCode: 'FLAT' });
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(7.5);
  });
});

describe('refund clawback (the capability the old lane lacked)', () => {
  it('a refunded order mirror-negates its commission; the projected balance and the D2 export show it immediately', async () => {
    await createAffiliate({ tenantId: T, orgId: ORG, code: 'CLAW', commissionType: 'percentage', commissionRate: 10, currency: 'USD' });
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-c1', createdAt: at(), total: 100, currency: 'USD', affiliateCode: 'CLAW' });
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-c2', createdAt: at(), total: 50, currency: 'USD', affiliateCode: 'CLAW' });
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(15);

    expect(await reverseCommission({ tenantId: T, orderId: 'ord-c1' })).toBe(1);
    expect(await reverseCommission({ tenantId: T, orderId: 'ord-c1' })).toBe(0); // idempotent
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(5); // 15 − 10

    const rows = await payoutExportRows(T, ORG);
    expect(rows[0]).toMatchObject({ code: 'CLAW', balanceOwed: 5, pendingPayouts: 0 });
  });
});

describe('payout (payee-scoped ledger run)', () => {
  it('claims the net (accruals minus clawbacks), writes the compat Payout row, and refuses a second payout', async () => {
    const aff = await createAffiliate({ tenantId: T, orgId: ORG, code: 'PAY', commissionType: 'percentage', commissionRate: 10, currency: 'USD' });
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-p1', createdAt: at(), total: 300, currency: 'USD', affiliateCode: 'PAY' });
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-p2', createdAt: at(), total: 100, currency: 'USD', affiliateCode: 'PAY' });
    await reverseCommission({ tenantId: T, orderId: 'ord-p2' });

    const payout = await recordPayout(T, ORG, aff.affiliateId);
    expect(payout.amount).toBe(30); // 40 − 10 clawback
    expect(payout.status).toBe('pending'); // advisory — disbursement is operator last-mile
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(0);
    expect(await listPayouts(T, ORG)).toHaveLength(1);
    await expect(recordPayout(T, ORG, aff.affiliateId)).rejects.toThrow(/No balance owed/);
  });
});

describe('grade fixes (2026-07-20 review)', () => {
  it('LOW-3 — a cross-currency accrual is refused loudly, never silently mislabeled', async () => {
    await createAffiliate({ tenantId: T, orgId: ORG, code: 'JPYAFF', commissionType: 'percentage', commissionRate: 10, currency: 'USD' });
    expect(await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-x1', createdAt: at(), total: 5000, currency: 'jpy', affiliateCode: 'JPYAFF' })).toBe(0);
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(0);
  });

  it('LOW-4 — percentage commissions floor at the minor unit (the never-over-credit law; a conscious change from round-half)', async () => {
    await createAffiliate({ tenantId: T, orgId: ORG, code: 'EDGE', commissionType: 'percentage', commissionRate: 12.5, currency: 'USD' });
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-x2', createdAt: at(), total: 1, currency: 'USD', affiliateCode: 'EDGE' });
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(0.12); // floor(12.5) minor — old round2 gave 0.13
  });
});

describe('opening-balance backfill (ADR 0447 D3)', () => {
  it('a frozen balanceOwed becomes ONE deterministic row; re-running backfills nothing', async () => {
    // Simulate a pre-migration affiliate: a stored row with a non-zero frozen
    // balance and NO ledger rows (created via the normal path, then hand-frozen).
    const aff = await createAffiliate({ tenantId: T, orgId: ORG, code: 'OLD', commissionType: 'percentage', commissionRate: 10, currency: 'USD' });
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const raw = new DurableCollection<Record<string, unknown>>('commerce:affiliate', (a) => String(a.affiliateId), undefined, (a) => String(a.tenantId));
    const stored = await raw.get(aff.affiliateId);
    await raw.put({ ...stored, balanceOwed: 12.34 });

    expect(await backfillAffiliateLedger()).toBe(1);
    expect(await backfillAffiliateLedger()).toBe(0); // idempotent by KEY, no sentinel
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(12.34);

    // The opening balance pays out like any other accrual.
    const payout = await recordPayout(T, ORG, aff.affiliateId);
    expect(payout.amount).toBe(12.34);
    expect((await listAffiliates(T, ORG))[0]?.balanceOwed).toBe(0);
    // A re-run after payout must NOT resurrect the frozen balance: the opening
    // row exists (paid), so first-write-wins refuses a duplicate.
    expect(await backfillAffiliateLedger()).toBe(0);
  });
});
