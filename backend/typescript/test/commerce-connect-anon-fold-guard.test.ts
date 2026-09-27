/**
 * MPL-1 / WF-MKT-13 — the GEN-CC-1 `anon:` fold guard on ALL FOUR lanes.
 *
 * The guard existed on `startOnboarding` and `importSellers` and NOWHERE else,
 * while TWO in-code comments called the resulting orphan
 * "impossible-by-construction". A false comment is why this survived: it told
 * every later reader the class was closed.
 *
 * The two open lanes both key a durable row on a fold-eligible tenant:
 *   - `upsertPaidListing` → `paidListings` indexed by `sellerTenantId`, PLUS a
 *     shared `commerce-listing-publish` approval row stored under the same
 *     tenant. The route's seller-account precondition does not cover it: it is
 *     `lane === 'native-paid'` only, so `free` and `external-link` (the
 *     arbitrary-https-payout-URL lane the approval gate exists for) were open.
 *   - `createCheckout` → `orderIdFor(buyerTenantId, packName)` is the order id,
 *     the CAS key AND the Stripe idempotency key, and `hasPaidOrder` reads the
 *     same key. So an anon buyer pays and then LOSES the entitlement at fold.
 *
 * The fold is one-way, so every case here is about a refusal that must land
 * BEFORE the durable write, not after it. Each lane asserts the refusal AND that
 * no row landed — a 403 that still wrote the row would be strictly worse than no
 * guard, because the operator queue would then carry an unattributable seller.
 *
 * SABOTAGE PROBE, RUN (not asserted): making `isFoldEligibleTenant` return `true`
 * unconditionally reddens 8 of the 10 cases. The two that stay green are the
 * deliberate positive controls ("a SIGNED-IN seller is still admitted", "the
 * refusal is the FOLD guard, not the listing gates") — they exist to catch the
 * opposite failure, a guard that refuses everyone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  __resetCommerceConnect, paidListings, orders, sellers,
  isFoldEligibleTenant, assertFoldEligibleTenant,
} from '../src/features/commerce-connect/stores.js';
import { upsertPaidListing } from '../src/features/commerce-connect/listings.js';
import { createCheckout } from '../src/features/commerce-connect/orders.js';
import { startOnboarding } from '../src/features/commerce-connect/onboarding.js';
import { importSellers } from '../src/features/commerce-connect/adminOps.js';
import { listPendingCommerceListingApprovals } from '../src/host/approvalService.js';

const ANON = 'anon:sid-fold-guard';
const SIGNED_IN = 'user:fold-guard-real';
const PACK = 'vendor.foldguard.nodes';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCommerceConnect();
});

/** Every refusal is the SAME typed shape, from the SAME predicate. */
async function expectAnonRefusal(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({
    code: 'forbidden_scope',
    httpStatus: 403,
    details: { reason: 'anon_tenant' },
  });
}

describe('MPL-1 — lane 1: seller onboarding (already guarded; kept honest)', () => {
  it('refuses an anon tenant and writes no seller row', async () => {
    await expectAnonRefusal(startOnboarding(ANON, { returnUrl: 'https://x/r', refreshUrl: 'https://x/f' }));
    expect(await sellers.get(ANON)).toBeNull();
  });
});

describe('MPL-1 — lane 2: listing publish (THE OPEN LANE — external payout URL)', () => {
  it('refuses an anon seller on the external-link lane and writes NO listing and NO approval row', async () => {
    // The exact attack: no seller account is needed on this lane, so before the
    // fix an anonymous visitor could point a workspace listing at any https URL.
    await expectAnonRefusal(upsertPaidListing(ANON, {
      packName: PACK, lane: 'external-link', externalPaymentUrl: 'https://stripe-checkout-verify.example/pay',
    }));
    expect(await paidListings.get(PACK), 'no listing row may survive the refusal').toBeNull();
    // The approval row is stored under `tenantId: sellerTenantId`, so it strands
    // identically — and the operator card would render a seller identity that
    // ceases to exist at fold time.
    const pending = await listPendingCommerceListingApprovals();
    expect(pending.filter((a) => a.commerceListing?.packName === PACK)).toHaveLength(0);
  });

  it('refuses an anon seller on the FREE lane too (also ungated by the route precondition)', async () => {
    await expectAnonRefusal(upsertPaidListing(ANON, { packName: `${PACK}.free`, lane: 'free' }));
    expect(await paidListings.get(`${PACK}.free`)).toBeNull();
  });

  it('refuses an anon seller on native-paid (defence in depth behind the route check)', async () => {
    await expectAnonRefusal(upsertPaidListing(ANON, {
      packName: `${PACK}.paid`, lane: 'native-paid', priceMajorUnits: 99, currency: 'usd',
    }));
    expect(await paidListings.get(`${PACK}.paid`)).toBeNull();
  });

  it('a SIGNED-IN seller is still admitted — the guard is not a wall', async () => {
    const row = await upsertPaidListing(SIGNED_IN, {
      packName: PACK, lane: 'external-link', externalPaymentUrl: 'https://seller.example/pay',
    });
    expect(row.sellerTenantId).toBe(SIGNED_IN);
    expect(await paidListings.get(PACK)).not.toBeNull();
  });
});

describe('MPL-1 — lane 3: checkout (THE OPEN LANE — a real charge whose entitlement vanishes)', () => {
  it('refuses an anon buyer BEFORE the order row is minted', async () => {
    // Seeded so the refusal cannot be mistaken for "no such listing": a signed-in
    // buyer would get past the fold guard and fail on the listing gates instead.
    await upsertPaidListing(SIGNED_IN, { packName: PACK, lane: 'native-paid', priceMajorUnits: 50, currency: 'usd' });
    await expectAnonRefusal(createCheckout(ANON, PACK, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' }));
    // No order under the deterministic id, and none anywhere.
    expect(await orders.list()).toHaveLength(0);
  });

  it('the refusal is the FOLD guard, not the listing gates — a signed-in buyer gets past it', async () => {
    // Discriminator: without this, "rejects" above would be satisfied by any of
    // the six listing/seller gates and the guard could be absent.
    await upsertPaidListing(SIGNED_IN, { packName: PACK, lane: 'native-paid', priceMajorUnits: 50, currency: 'usd' });
    await expect(createCheckout('user:some-buyer', PACK, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' }))
      .rejects.not.toMatchObject({ details: { reason: 'anon_tenant' } });
  });
});

describe('MPL-1 — lane 4: the importer (counts and names its refusals)', () => {
  it('rejects an anon row by name and imports the signed-in one beside it', async () => {
    const out = await importSellers([
      { tenantId: ANON, stripeAccountId: 'acct_anon' },
      { tenantId: SIGNED_IN, stripeAccountId: 'acct_real' },
    ]);
    expect(out.rejected).toEqual([{ tenantId: ANON, reason: 'anon_tenant' }]);
    expect(out.sellers).toBe(1);
    expect(await sellers.get(ANON)).toBeNull();
    expect(await sellers.get(SIGNED_IN)).not.toBeNull();
  });
});

describe('MPL-1 — the predicate itself', () => {
  it('binds ONLY the `anon:` prefix — signed-in, demo and test tenants are unaffected', async () => {
    for (const t of ['user:abc', 'ws:abc', 'org:abc', 'default', 'anonymous-but-not-prefixed']) {
      expect(isFoldEligibleTenant(t), t).toBe(true);
      expect(() => assertFoldEligibleTenant(t, 'x')).not.toThrow();
    }
    expect(isFoldEligibleTenant('anon:')).toBe(false);
    expect(isFoldEligibleTenant('anon:sid')).toBe(false);
  });

  it('every lane refuses through the SAME predicate — one message shape, one reason code', async () => {
    // If a future author re-inlines `startsWith('anon:')` at one call site, the
    // shapes drift and this goes red before the drift becomes a second guard.
    const errs: Array<{ code?: string; details?: { reason?: string } }> = [];
    for (const p of [
      startOnboarding(ANON, { returnUrl: 'https://x/r', refreshUrl: 'https://x/f' }),
      upsertPaidListing(ANON, { packName: 'p1', lane: 'free' }),
      createCheckout(ANON, 'p1', { successUrl: 'https://x/s', cancelUrl: 'https://x/c' }),
    ]) {
      await p.catch((e) => errs.push(e as { code?: string; details?: { reason?: string } }));
    }
    expect(errs).toHaveLength(3);
    for (const e of errs) {
      expect(e.code).toBe('forbidden_scope');
      expect(e.details?.reason).toBe('anon_tenant');
    }
  });
});
