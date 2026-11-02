/**
 * Prepaid token-balance ledger CAS integrity (2026-07 vuln-scan Phase 3 H4).
 * drawFromBalance was get→put with no CAS — concurrent draws lost updates → free
 * tokens. The fix CASes each debit, re-reading + recomputing `drawn` per attempt.
 *
 * The race is FORCED, not hoped for: a one-shot hold on `DurableCollection.get` parks
 * both callers on their candidate read of the tenant's balance until both have arrived,
 * so both compute against 1000. The CAS loser must then re-read and debit from 600.
 *
 * Sabotage-witnessed (grade-tests w74): a blind `put` instead of the CAS reds the race
 * case (600 left, an update lost); drawing `tokens` uncapped reds the cap case; not
 * debiting reds the debit / cap / empty cases; dropping the `tokens <= 0` guard reds the
 * non-positive case on a NEGATIVE request (it would mint tokens; a request of 0 is an
 * equivalent mutant, `Math.min(0, n) = 0`).
 *
 * DOUBLE GUARD: an empty balance is refused by the `totalAvailable <= 0` early return AND
 * by `Math.min(tokens, 0) = 0`; removing either alone is an equivalent mutant.
 *
 * Cases 1–3 overlap `test/billing.test.ts` "draws from balance before the daily cap"
 * (protected money tests: dedupe only on a human ask).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { drawFromBalance, getBalance, importBillingState } from '../billingService.js';
import { DurableCollection, initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';

let seq = 0;
let tenant = '';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(async () => {
  tenant = `ws:bal-${++seq}`; // fresh tenant per test (no cross-test balance bleed)
  await importBillingState({ balances: [{ tenantId: tenant, purchasedTokensTotal: 1000, totalAvailable: 1000, updatedAt: '2026-01-01T00:00:00.000Z' }] });
});

describe('drawFromBalance (CAS)', () => {
  it('debits the exact amount and persists the new balance', async () => {
    expect(await drawFromBalance(tenant, 400)).toBe(400);
    expect((await getBalance(tenant)).totalAvailable).toBe(600);
    expect(await drawFromBalance(tenant, 400)).toBe(400);
    expect((await getBalance(tenant)).totalAvailable).toBe(200);
  });

  it('caps the draw at the available balance (never goes negative)', async () => {
    await drawFromBalance(tenant, 900); // → 100 left
    expect(await drawFromBalance(tenant, 400)).toBe(100); // only 100 available
    expect((await getBalance(tenant)).totalAvailable).toBe(0);
  });

  it('draws nothing from an empty balance', async () => {
    await drawFromBalance(tenant, 1000); // drain
    expect(await drawFromBalance(tenant, 50)).toBe(0);
    expect((await getBalance(tenant)).totalAvailable).toBe(0);
  });

  it('is a no-op for a non-positive request', async () => {
    expect(await drawFromBalance(tenant, 0)).toBe(0);
    expect((await getBalance(tenant)).totalAvailable).toBe(1000);
    // A negative request must not CREDIT the balance.
    expect(await drawFromBalance(tenant, -5)).toBe(0);
    expect((await getBalance(tenant)).totalAvailable).toBe(1000);
  });

  it('two concurrent draws both land — the CAS loser re-reads, no lost update (H4)', async () => {
    const realGet = DurableCollection.prototype.get;
    let arrivals = 0;
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((r) => { release = r; });
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => { fallback = setTimeout(r, 2000); });
    // One-shot hold on the CANDIDATE read (before the CAS): the first two reads of this
    // tenant's balance park until both callers are inside the window.
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      if (id === tenant && arrivals < 2) {
        arrivals++;
        if (arrivals === 2) release();
        await Promise.race([bothArrived, timeout]);
      }
      return realGet.call(this, id);
    });
    try {
      const results = await Promise.all([drawFromBalance(tenant, 400), drawFromBalance(tenant, 400)]);
      expect(arrivals).toBe(2); // the race was forced
      expect(results).toEqual([400, 400]); // the loser retried and still drew in full
      expect((await getBalance(tenant)).totalAvailable).toBe(200);
    } finally {
      spy.mockRestore();
      clearTimeout(fallback);
    }
  });
});
