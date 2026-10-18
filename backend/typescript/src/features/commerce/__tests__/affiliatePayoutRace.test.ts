/**
 * Affiliate money integrity (2026-07 vuln-scan Phase 3 M5 → ADR 0447 P2). The M5
 * races are now impossible BY CONSTRUCTION on the obligation ledger: accruals are
 * independent per-order rows (nothing to lose to CAS contention), and a payout is
 * a payee-scoped CAS-claimed run (a second payout finds no unclaimed rows and is
 * refused 409 — no duplicate disbursement).
 *
 * The FORCED race at the bottom is this file's reason to exist (w39 grade-tests): two
 * payouts are both held after reading the SAME unclaimed rows, then released, so the
 * only thing standing between them and a double disbursement is the per-row claim
 * CAS in `createRun` (`host/obligationLedger.ts`). Replacing that CAS with a blind
 * `put` turns it red. The three sequential cases above it are kept as cheap
 * proxies; each names its stronger twin in `test/commerce-affiliate-ledger.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createAffiliate, accrueCommission, recordPayout, listPayouts, affiliateByCode, __resetAffiliates } from '../affiliate.js';
import { OpenwopError } from '../../../types.js';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import type { Storage } from '../../../storage/storage.js';

const T = 'ws:aff-test';
const ORG = 'org-aff';

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
beforeEach(async () => {
  await __resetAffiliates();
});
afterEach(() => { vi.restoreAllMocks(); });

async function seed(): Promise<string> {
  const aff = await createAffiliate({ tenantId: T, orgId: ORG, code: 'REF10', commissionType: 'fixed', commissionRate: 10, currency: 'usd' });
  return aff.affiliateId;
}

describe('affiliate commission accrual (CAS)', () => {
  // Stronger twin: commerce-affiliate-ledger "refund clawback … mirror-negates its commission"
  // (the same `sourceId` sabotage reds both).
  it('accrues each paid order additively', async () => {
    await seed();
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-a1', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-a2', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    const aff = await affiliateByCode(T, ORG, 'REF10');
    expect(aff?.balanceOwed).toBe(20);
  });
});

describe('affiliate payout (CAS-then-create, fail-closed)', () => {
  // Stronger twin: commerce-affiliate-ledger "payout … claims the net (accruals minus clawbacks)".
  it('records one payout for the full owed balance and zeroes it', async () => {
    const id = await seed();
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-p1', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    const payout = await recordPayout(T, ORG, id);
    expect(payout.amount).toBe(10);
    expect((await affiliateByCode(T, ORG, 'REF10'))?.balanceOwed).toBe(0);
    expect(await listPayouts(T, ORG)).toHaveLength(1);
  });

  // Stronger twin: commerce-affiliate-ledger "payout … refuses a second payout" (asserts the message).
  it('refuses a SECOND payout on the now-zeroed balance (no duplicate disbursement)', async () => {
    const id = await seed();
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-p2', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    await recordPayout(T, ORG, id);
    await expect(recordPayout(T, ORG, id)).rejects.toBeInstanceOf(OpenwopError);
    // still exactly one payout row — the balance was claimed exactly once.
    expect(await listPayouts(T, ORG)).toHaveLength(1);
  });
});

/**
 * Hold the first `callers` reads of THIS affiliate's ledger rows — `createRun`'s
 * candidate scan — until all of them have arrived, then release them together. Both
 * payouts therefore claim from the SAME snapshot of unclaimed rows: the row CAS is
 * the only guard left. One-shot: later reads (confirm, the balance projection) pass
 * straight through. A fallback releases the gate so a path that never brings the
 * second caller here fails `arrivals()` instead of hanging the case.
 */
function holdCandidateScansUntil(tenantId: string, callers: number): { arrivals: () => number } {
  const realList = storage.kvList.bind(storage);
  const prefix = `hostext:commerce:affiliate-ledger:${tenantId}::`;
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fallback = setTimeout(() => release(), 2_000);
  vi.spyOn(storage, 'kvList').mockImplementation(async (p: string) => {
    const rows = await realList(p);
    if (p === prefix && arrived < callers) {
      arrived += 1;
      if (arrived >= callers) { clearTimeout(fallback); release(); }
      await gate;
    }
    return rows;
  });
  return { arrivals: () => arrived };
}

describe('affiliate payout — FORCED concurrent race (M5b: no duplicate disbursement)', () => {
  it('two payouts that both read the same unclaimed balance: exactly one pays 10, the other is refused', async () => {
    const id = await seed();
    await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'ord-race', createdAt: new Date().toISOString(), total: 100, currency: 'usd', affiliateCode: 'REF10' });
    const held = holdCandidateScansUntil(T, 2);
    const results = await Promise.allSettled([recordPayout(T, ORG, id), recordPayout(T, ORG, id)]);
    expect(held.arrivals()).toBe(2); // both really were inside the window, on the same snapshot

    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof recordPayout>>> => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    expect(won[0]!.value.amount).toBe(10);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ code: 'validation_error', httpStatus: 409, message: 'No balance owed.' });

    const stored = await listPayouts(T, ORG);
    expect(stored).toHaveLength(1); // exactly ONE disbursement recorded
    expect(stored[0]).toMatchObject({ affiliateId: id, amount: 10 });
    expect((await affiliateByCode(T, ORG, 'REF10'))?.balanceOwed).toBe(0);
  });
});
