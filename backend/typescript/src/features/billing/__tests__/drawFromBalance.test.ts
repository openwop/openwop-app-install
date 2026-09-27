/**
 * Prepaid token-balance ledger CAS integrity (2026-07 vuln-scan Phase 3 H4).
 * drawFromBalance was get→put with no CAS — concurrent draws lost updates → free
 * tokens. The fix CASes each debit, re-reading + recomputing `drawn` per attempt.
 * A true race is non-deterministic; these cover the debit arithmetic + caps +
 * empty-balance behavior the CAS loop must preserve.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { drawFromBalance, getBalance, importBillingState } from '../billingService.js';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';

let seq = 0;
let tenant = '';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(async () => {
  tenant = `ws:bal-${++seq}`; // fresh tenant per test (no cross-test balance bleed)
  await importBillingState({ balances: [{ tenantId: tenant, purchasedTokensTotal: 1000, totalAvailable: 1000, updatedAt: new Date().toISOString() }] });
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
  });

  it('is a no-op for a non-positive request', async () => {
    expect(await drawFromBalance(tenant, 0)).toBe(0);
    expect((await getBalance(tenant)).totalAvailable).toBe(1000);
  });
});
