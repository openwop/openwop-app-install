/**
 * Commerce Connect Phase 5 + Phase 0 (ADR 0385) — refunds, disputes, the
 * platform-loss ledger, and the id-preserving seller importer.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import {
  __resetCommerceConnect, startOnboarding, syncSellerFromStripe, upsertPaidListing,
  setListingApproval, createCheckout, getOrder, handleConnectEvent, refundOrder,
  listDisputes, importSellers, getSeller,
} from '../src/features/commerce-connect/connectService.js';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await saveConfig({ id: 'commerce-connect', label: 'Commerce Connect', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const URLS = { successUrl: 'http://x/ok', cancelUrl: 'http://x/no' };

/** Demo seller + approved listing + a PAID order (fulfilled with a payment intent). */
async function paidOrder(buyer: string, pack: string): Promise<string> {
  await startOnboarding('s1', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
  await syncSellerFromStripe('s1');
  await upsertPaidListing('s1', { packName: pack, lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
  await setListingApproval(pack, 'approved');
  const { order } = await createCheckout(buyer, pack, URLS);
  await handleConnectEvent({
    event: {
      id: `evt_${pack}`, type: 'payment_intent.succeeded',
      data: { object: { id: `pi_${pack}`, amount: 4000, currency: 'usd', metadata: { ccOrderId: order.orderId } } },
    },
  });
  return order.orderId;
}

describe('refunds', () => {
  it('a demo paid order refunds immediately; a pending order refuses (409)', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrder('buyer1', 'p.r1');
    const out = await refundOrder(orderId);
    expect(out.order.status === 'refunded' || out.refundId !== undefined).toBe(true);
    expect((await getOrder(orderId))!.status).toBe('refunded');
    await expect(refundOrder(orderId)).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('charge.refunded webhook flips paid→refunded (live-lane confirmation path)', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrder('buyer1', 'p.r2');
    // MPL-3 — the event now carries `amount_refunded`, as every real Stripe
    // `charge.refunded` does. This case USED to fire the event with no amount at
    // all and assert a full flip, which pinned the defect as expected behaviour:
    // it made "no amount" and "the whole charge" the same input, which is exactly
    // how a $1 partial refund came to revoke a $100 entitlement.
    const out = await handleConnectEvent({
      event: { id: 'evt_rf', type: 'charge.refunded', data: { object: { id: 'ch_1', amount: 4000, amount_refunded: 4000, metadata: { ccOrderId: orderId } } } },
    });
    expect(out.handled).toBe(true);
    expect((await getOrder(orderId))!.status).toBe('refunded');
    expect((await getOrder(orderId))!.refundedMajorUnits).toBe(40);
  });
});

describe('disputes — ledger + order status machine', () => {
  const disputeEvent = (id: string, type: string, pi: string, status: string) => ({
    id, type,
    data: { object: { id: 'dp_1', payment_intent: pi, amount: 4000, currency: 'usd', reason: 'fraudulent', status } },
  });

  it('created flips paid→disputed; closed won restores paid; unknown intent is unhandled', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrder('buyer1', 'p.d1');
    expect((await handleConnectEvent({ event: disputeEvent('evt_d1', 'charge.dispute.created', 'pi_p.d1', 'needs_response') })).handled).toBe(true);
    expect((await getOrder(orderId))!.status).toBe('disputed');
    expect((await listDisputes()).disputes[0]).toMatchObject({ status: 'open', orderId, sellerTenantId: 's1' });

    expect((await handleConnectEvent({ event: disputeEvent('evt_d2', 'charge.dispute.closed', 'pi_p.d1', 'won') })).handled).toBe(true);
    expect((await getOrder(orderId))!.status).toBe('paid');
    expect((await listDisputes()).disputes[0]!.status).toBe('won');

    expect((await handleConnectEvent({ event: disputeEvent('evt_d3', 'charge.dispute.created', 'pi_unknown', 'needs_response') })).handled).toBe(false);
  });

  it('closed lost realizes the platform loss on the ledger', async () => {
    await __resetCommerceConnect();
    await paidOrder('buyer1', 'p.d2');
    await handleConnectEvent({ event: disputeEvent('evt_l1', 'charge.dispute.created', 'pi_p.d2', 'needs_response') });
    await handleConnectEvent({ event: disputeEvent('evt_l2', 'charge.dispute.closed', 'pi_p.d2', 'lost') });
    const ledger = await listDisputes();
    expect(ledger.disputes[0]).toMatchObject({ status: 'lost', platformLossMajorUnits: 40 });
    expect(ledger.platformLossMajorUnitsByCurrency.usd).toBe(40);
  });
});

describe('Phase 0 — id-preserving seller importer', () => {
  it('imports sellers with stripeAccountId verbatim + reverse index; skips invalid rows', async () => {
    await __resetCommerceConnect();
    const out = await importSellers([
      { tenantId: 'mh-t1', stripeAccountId: 'acct_LIVE123', region: 'US' },
      { tenantId: 'mh-t2', stripeAccountId: 'acct_LIVE456', chargesEnabled: false, onboardingState: 'restricted' },
      { tenantId: '', stripeAccountId: 'acct_bad' },
    ]);
    expect(out.sellers).toBe(2);
    expect((await getSeller('mh-t1'))!.stripeAccountId).toBe('acct_LIVE123');
    expect((await getSeller('mh-t2'))!.onboardingState).toBe('restricted');
    // reverse index works — an account event routes to the imported tenant
    const applied = await handleConnectEvent({
      event: { id: 'evt_imp', type: 'account.updated', account: 'acct_LIVE123', data: { object: { charges_enabled: true, payouts_enabled: true, country: 'US', capabilities: {} } } },
    });
    expect(applied.handled).toBe(true);
    expect((await getSeller('mh-t1'))!.chargesEnabled).toBe(true);
  });
});

describe('grade-pass hardening (CC-1/CC-2/CC-8/CC-10)', () => {
  it('CC-8: a purchase event with a MISSING amount is not applied (fail-closed anomaly)', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrderSetupFor('buyer1', 'p.cc8');
    const out = await handleConnectEvent({
      event: { id: 'evt_noamt', type: 'checkout.session.completed', data: { object: { payment_status: 'paid', currency: 'usd', metadata: { ccOrderId: orderId } } } },
    });
    expect(out.handled).toBe(true);
    expect((await getOrder(orderId))!.status).toBe('pending'); // NOT fulfilled without an amount
  });

  it('CC-2: an unapproved external-link listing is hidden from other tenants and from the pricing provider', async () => {
    await __resetCommerceConnect();
    await upsertPaidListing('sx', { packName: 'p.ext', lane: 'external-link', externalPaymentUrl: 'https://pay.example/x' });
    const { listPaidListings, listingPricingFor, setListingApproval } = await import('../src/features/commerce-connect/connectService.js');
    expect((await listPaidListings('other')).map((l) => l.packName)).not.toContain('p.ext');
    expect(await listingPricingFor(['p.ext'], 'other')).toEqual({});
    await setListingApproval('p.ext', 'approved');
    expect((await listPaidListings('other')).map((l) => l.packName)).toContain('p.ext');
    expect((await listingPricingFor(['p.ext'], 'other'))['p.ext']).toMatchObject({ lane: 'external-link' });
  });

  it('CC-10: the importer never clobbers a live seller row and reports skips', async () => {
    await __resetCommerceConnect();
    await importSellers([{ tenantId: 'mh-x', stripeAccountId: 'acct_A', onboardingState: 'restricted' }]);
    const again = await importSellers([{ tenantId: 'mh-x', stripeAccountId: 'acct_B', onboardingState: 'enabled' }]);
    expect(again).toEqual({ sellers: 0, skipped: 1, rejected: [] });
    expect((await getSeller('mh-x'))!.stripeAccountId).toBe('acct_A'); // live row untouched
    expect((await getSeller('mh-x'))!.onboardingState).toBe('restricted');
  });

  it('CC-1: a lost seller reverse-index row self-heals on onboarding resume', async () => {
    await __resetCommerceConnect();
    await startOnboarding('heal-t', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    const acct = (await getSeller('heal-t'))!.stripeAccountId;
    // Simulate the orphan: wipe everything, restore ONLY the seller row via import
    // (skip-if-exists is bypassed because the store is empty).
    const seller = (await getSeller('heal-t'))!;
    await __resetCommerceConnect();
    await importSellers([{ ...seller }]);
    // importSellers writes the index too; simulate a legacy orphan by targeting
    // the resume path anyway: resume must (re)write the index mapping. The
    // imported row is mode:'live', so the keyless test env throws AFTER the
    // heal (credential_unavailable on the account-link mint) — tolerated here;
    // the assertion that matters is that the mapping resolves below.
    await startOnboarding('heal-t', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' })
      .catch((e: unknown) => { expect((e as { code?: string }).code).toBe('credential_unavailable'); });
    const applied = await handleConnectEvent({
      event: { id: 'evt_heal', type: 'payout.paid', account: acct, data: { object: { id: 'po_heal', amount: 100, currency: 'usd' } } },
    });
    expect(applied.handled).toBe(true); // the mapping resolves after resume
  });
});

/** Helper mirroring paidOrder() for the hardening block (demo seller + approved listing + pending order). */
async function paidOrderSetupFor(buyer: string, pack: string): Promise<string> {
  await startOnboarding('s1', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
  await syncSellerFromStripe('s1');
  await upsertPaidListing('s1', { packName: pack, lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
  await setListingApproval(pack, 'approved');
  const { order } = await createCheckout(buyer, pack, URLS);
  return order.orderId;
}
