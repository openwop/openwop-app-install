/**
 * ADR 0574 (listing ownership & lifecycle) + ADR 0576 (seller binding
 * integrity) — service-level pins.
 *
 *  - Dissolution tombstones (never hard-deletes): the listing leaves browse
 *    and checkout, the SAME seller cannot re-claim inside the 90-day cooldown,
 *    a DIFFERENT seller can.
 *  - `suspended` is the operator hold: not purchasable, releasable.
 *  - The projection's `purchasable` folds the REGION guard (CC2-M4): the UI
 *    never renders a Buy that checkout will 409.
 *  - A stripeAccountId binds to ONE tenant: import refuses rebinding and
 *    `anon:` tenants with NAMED reasons; reconciliation flags divergence.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  __resetCommerceConnect, startOnboarding, syncSellerFromStripe, upsertPaidListing,
  setListingApproval, createCheckout, listingPricingFor, dissolveListing, setListingState,
  importSellers, bindSellerAccount, reconcileSellerBindings, platformRegion,
} from '../src/features/commerce-connect/connectService.js';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const URLS = { successUrl: 'http://x/s', cancelUrl: 'http://x/c' };

async function enabledSeller(tenantId: string): Promise<void> {
  await startOnboarding(tenantId, { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
  await syncSellerFromStripe(tenantId);
}

describe('ADR 0574 — dissolution, cooldown, suspension, and the ONE purchasable predicate', () => {
  it('a dissolved listing leaves browse and checkout; cooldown binds the SAME seller only', async () => {
    await __resetCommerceConnect();
    await enabledSeller('sl-a');
    await upsertPaidListing('sl-a', { packName: 'p.life', lane: 'native-paid', priceMajorUnits: 10, currency: 'usd' });
    await setListingApproval('p.life', 'approved');
    expect((await listingPricingFor(['p.life'], 'buyer-t'))['p.life']?.purchasable).toBe(true);

    await dissolveListing('p.life', 'op-1', 'squatted name');
    expect((await listingPricingFor(['p.life'], 'buyer-t'))['p.life']).toBeUndefined();      // gone from browse
    await expect(createCheckout('buyer-t', 'p.life', URLS)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'listing_not_active', state: 'tombstoned' } });
    // Same seller inside cooldown: refused, named.
    await expect(upsertPaidListing('sl-a', { packName: 'p.life', lane: 'native-paid', priceMajorUnits: 10, currency: 'usd' }))
      .rejects.toMatchObject({ code: 'forbidden', details: { reason: 'listing_tombstoned_cooldown' } });
    // A DIFFERENT seller may claim the freed name.
    await enabledSeller('sl-b');
    const claimed = await upsertPaidListing('sl-b', { packName: 'p.life', lane: 'native-paid', priceMajorUnits: 12, currency: 'usd' });
    expect(claimed.sellerTenantId).toBe('sl-b');
  });

  it('suspended = operator hold: not purchasable, checkout refuses TYPED, release restores', async () => {
    await __resetCommerceConnect();
    await enabledSeller('sl-s');
    await upsertPaidListing('sl-s', { packName: 'p.hold', lane: 'native-paid', priceMajorUnits: 10, currency: 'usd' });
    await setListingApproval('p.hold', 'approved');
    await setListingState('p.hold', 'suspended', 'op-1', 'dispute open');
    expect((await listingPricingFor(['p.hold'], 'buyer-t'))['p.hold']).toBeUndefined();
    await expect(createCheckout('buyer-t', 'p.hold', URLS)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'listing_not_active', state: 'suspended' } });
    await setListingState('p.hold', 'active', 'op-1', 'dispute resolved');
    expect((await listingPricingFor(['p.hold'], 'buyer-t'))['p.hold']?.purchasable).toBe(true);
  });

  it('CC2-M4 fold: a cross-region seller is NOT purchasable in the projection (no Buy → 409)', async () => {
    await __resetCommerceConnect();
    // The importer can mint a seller with an explicit region ≠ platformRegion.
    const out = await importSellers([{ tenantId: 'sl-eu', stripeAccountId: 'acct_eu_1', region: `not-${platformRegion()}` }]);
    expect(out.sellers).toBe(1);
    await upsertPaidListing('sl-eu', { packName: 'p.region', lane: 'native-paid', priceMajorUnits: 10, currency: 'usd' });
    await setListingApproval('p.region', 'approved');
    const pricing = (await listingPricingFor(['p.region'], 'buyer-t'))['p.region'];
    expect(pricing?.purchasable).toBe(false); // the projection agrees with checkout's region 409
  });
});

describe('ADR 0576 — the binding invariant', () => {
  it('import refuses rebinding a bound account AND anon tenants, with NAMED reasons; the index is untouched', async () => {
    await __resetCommerceConnect();
    const first = await importSellers([{ tenantId: 'owner-t', stripeAccountId: 'acct_bind_1' }]);
    expect(first.sellers).toBe(1);
    const second = await importSellers([
      { tenantId: 'attacker-t', stripeAccountId: 'acct_bind_1' },   // rebinding
      { tenantId: 'anon:visitor', stripeAccountId: 'acct_bind_2' }, // anon seller
    ]);
    expect(second.sellers).toBe(0);
    expect(second.rejected).toEqual(expect.arrayContaining([
      { tenantId: 'attacker-t', reason: 'account_already_bound' },
      { tenantId: 'anon:visitor', reason: 'anon_tenant' },
    ]));
    // The binding CAS refuses directly too.
    await expect(bindSellerAccount('attacker-t', 'acct_bind_1')).rejects.toMatchObject({ code: 'conflict', details: { reason: 'binding_conflict' } });
    await expect(bindSellerAccount('owner-t', 'acct_bind_1')).resolves.toBeUndefined(); // same-tenant idempotent
  });

  it('reconciliation flags divergence as an incident (an index row with no agreeing seller)', async () => {
    await __resetCommerceConnect();
    await importSellers([{ tenantId: 'ok-t', stripeAccountId: 'acct_ok' }]);
    await bindSellerAccount('ghost-t', 'acct_ghost'); // index row, NO seller row
    const out = await reconcileSellerBindings();
    expect(out.checked).toBeGreaterThanOrEqual(2);
    expect(out.divergent).toBe(1);
  });
});
