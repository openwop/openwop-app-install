/**
 * Affiliate money integrity (2026-07 vuln-scan Phase 3 M5 → ADR 0447 P2). The M5
 * races are now impossible BY CONSTRUCTION on the obligation ledger: accruals are
 * independent per-order rows (nothing to lose to CAS contention), and a payout is
 * a payee-scoped CAS-claimed run (a second payout finds no unclaimed rows and is
 * refused 409 — no duplicate disbursement). Same deterministic proxies as before.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createAffiliate, accrueCommission, recordPayout, listPayouts, affiliateByCode, __resetAffiliates } from '../affiliate.js';
import { OpenwopError } from '../../../types.js';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';

const T = 'ws:aff-test';
const ORG = 'org-aff';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(async () => {
  await __resetAffiliates();
});

async function seed(): Promise<string> {
  const aff = await createAffiliate({ tenantId: T, orgId: ORG, code: 'REF10', commissionType: 'fixed', commissionRate: 10, currency: 'usd' });
  return aff.affiliateId;
}

describe('affiliate commission accrual (CAS)', () => {
  it('accrues each paid order additively', async () => {
    await seed();
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-a1', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-a2', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    const aff = await affiliateByCode(T, ORG, 'REF10');
    expect(aff?.balanceOwed).toBe(20);
  });
});

describe('affiliate payout (CAS-then-create, fail-closed)', () => {
  it('records one payout for the full owed balance and zeroes it', async () => {
    const id = await seed();
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-p1', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    const payout = await recordPayout(T, ORG, id);
    expect(payout.amount).toBe(10);
    expect((await affiliateByCode(T, ORG, 'REF10'))?.balanceOwed).toBe(0);
    expect(await listPayouts(T, ORG)).toHaveLength(1);
  });

  it('refuses a SECOND payout on the now-zeroed balance (no duplicate disbursement)', async () => {
    const id = await seed();
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-p2', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    await recordPayout(T, ORG, id);
    await expect(recordPayout(T, ORG, id)).rejects.toBeInstanceOf(OpenwopError);
    // still exactly one payout row — the balance was claimed exactly once.
    expect(await listPayouts(T, ORG)).toHaveLength(1);
  });
});
