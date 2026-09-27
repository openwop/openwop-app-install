/**
 * Commerce Connect Phase 2 (ADR 0385) — purchase harness. Verifies: listing
 * lanes + validation, the native-paid approval fail-close, self-purchase and
 * re-buy guards, fee clamp (read + write + corrupt-row fail-closed), the
 * deterministic order id, demo checkout, purchase-event fulfilment (CAS
 * exactly-once under concurrent duplicate delivery, amount-mismatch refusal,
 * async-payment ignore, money-truth toggle exception), and order IDOR routes.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { tombstonePack, restorePack, __clearPackTombstones } from '../src/host/packTombstones.js';
import {
  __resetCommerceConnect, startOnboarding, syncSellerFromStripe, upsertPaidListing,
  setListingApproval, createCheckout, getOrder, orderIdFor, handleConnectEvent,
  getApplicationFeePct, setApplicationFeePct, listPaidListings, hasPaidOrder, listOrdersFor,
} from '../src/features/commerce-connect/connectService.js';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await saveConfig({ id: 'commerce-connect', label: 'Commerce Connect (seller marketplace)', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const URLS = { successUrl: 'http://x/ok', cancelUrl: 'http://x/no' };

/** Demo seller enabled + an approved native-paid listing. */
async function sellerWithListing(sellerTenant: string, packName: string, price = 40): Promise<void> {
  await startOnboarding(sellerTenant, { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
  await syncSellerFromStripe(sellerTenant); // demo → enabled
  await upsertPaidListing(sellerTenant, { packName, lane: 'native-paid', priceMajorUnits: price, currency: 'usd' });
  await setListingApproval(packName, 'approved');
}

describe('listings — lanes, validation, approval fail-close', () => {
  it('native-paid needs price+currency; external-link needs https URL', async () => {
    await __resetCommerceConnect();
    await expect(upsertPaidListing('s1', { packName: 'p.a', lane: 'native-paid' })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(upsertPaidListing('s1', { packName: 'p.a', lane: 'external-link', externalPaymentUrl: 'http://insecure' })).rejects.toMatchObject({ httpStatus: 400 });
    const ok = await upsertPaidListing('s1', { packName: 'p.a', lane: 'external-link', externalPaymentUrl: 'https://pay.example/p' });
    // Grade pass CC-2 (ADR 0385 correction): external-link is approval-gated too
    // (multi-tenant phishing/name-squat vector) — only the FREE lane is ungated.
    expect(ok.approvalState).toBe('pending');
    const free = await upsertPaidListing('s1', { packName: 'p.a2', lane: 'free' });
    expect(free.approvalState).toBeUndefined();
  });

  it('a seller cannot list a pack another seller already listed', async () => {
    await __resetCommerceConnect();
    await upsertPaidListing('s1', { packName: 'p.b', lane: 'free' });
    await expect(upsertPaidListing('s2', { packName: 'p.b', lane: 'free' })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('unapproved native-paid is not purchasable and hidden from other tenants', async () => {
    await __resetCommerceConnect();
    await startOnboarding('s1', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    await syncSellerFromStripe('s1');
    await upsertPaidListing('s1', { packName: 'p.c', lane: 'native-paid', priceMajorUnits: 10, currency: 'usd' });
    await expect(createCheckout('buyer1', 'p.c', URLS)).rejects.toMatchObject({ httpStatus: 409 });
    expect((await listPaidListings('buyer1')).map((l) => l.packName)).not.toContain('p.c');
    expect((await listPaidListings('s1')).map((l) => l.packName)).toContain('p.c'); // own row visible
  });

  it('approval is dropped when the seller changes the price (re-enters the queue)', async () => {
    await __resetCommerceConnect();
    await sellerWithListing('s1', 'p.d', 10);
    const edited = await upsertPaidListing('s1', { packName: 'p.d', lane: 'native-paid', priceMajorUnits: 99, currency: 'usd' });
    expect(edited.approvalState).toBe('pending');
  });
});

describe('fee config — clamp + fail-closed default', () => {
  it('clamps writes and reads into 10–15; default 12', async () => {
    await __resetCommerceConnect();
    expect(await getApplicationFeePct('any')).toBe(12);
    expect((await setApplicationFeePct('__global__', 50)).applicationFeePct).toBe(15);
    expect(await getApplicationFeePct('any')).toBe(15);
    expect((await setApplicationFeePct('t9', 3)).applicationFeePct).toBe(10);
    expect(await getApplicationFeePct('t9')).toBe(10);
    await expect(setApplicationFeePct('__global__', NaN)).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe('checkout — deterministic order, guards, demo lane', () => {
  it('demo checkout creates a pending order with the deterministic id + fee', async () => {
    await __resetCommerceConnect();
    await sellerWithListing('s1', 'p.e', 40);
    const started = await createCheckout('buyer1', 'p.e', URLS);
    expect(started.mode).toBe('demo');
    expect(started.order.orderId).toBe(orderIdFor('buyer1', 'p.e'));
    expect(started.order.applicationFeeMajorUnits).toBeCloseTo(4.8); // 12% of 40
    expect(started.url).toBe(`demo:checkout:${started.order.orderId}`);
    // repeat click — same order, no duplicate
    const again = await createCheckout('buyer1', 'p.e', URLS);
    expect(again.order.orderId).toBe(started.order.orderId);
  });

  it('a REMOVED pack cannot be purchased — no charge for an entitlement to nothing (CC2-B2)', async () => {
    // The browse surface annotated `packMissing` and its comment claimed the
    // purchase gate lived in the service. It did not: `createCheckout` checked
    // lane, approval, self-purchase, seller readiness and price, and nothing
    // about the pack still existing. So an approved listing survived the pack's
    // removal and stayed purchasable — a live Stripe charge, then `hasPaidOrder`
    // granting an entitlement to a pack that is gone, recoverable only by a
    // manual superadmin refund.
    await __resetCommerceConnect();
    await __clearPackTombstones();
    await sellerWithListing('s1', 'p.removed', 25);

    // Control FIRST: purchasable BEFORE the tombstone, so the refusal below is
    // attributable to the tombstone and not to anything else in the setup.
    //
    // HONEST LABEL (CC2-R1): `p.removed` is not an installed pack on this host
    // at any point, so this establishes "untombstoned ⇒ purchasable" — NOT
    // "present ⇒ purchasable". An earlier version of this comment claimed the
    // latter, which quietly asserted that selling an ABSENT pack is the good
    // path: a test pinning the half of CC2-B2 that the money gate deliberately
    // does not close. That half is closed at the approval card instead
    // (`packMissing`), and what remains open is tracked as CC2-R1.

    const ok = await createCheckout('buyer-rm', 'p.removed', URLS);
    expect(ok.order.orderId).toBeTruthy();

    await __resetCommerceConnect();
    await sellerWithListing('s1', 'p.removed', 25);
    await tombstonePack('p.removed', 'operator-1');
    await expect(createCheckout('buyer-rm2', 'p.removed', URLS))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'pack_removed' } });

    // …and RESTORING the pack makes it purchasable again — the refusal is keyed
    // on the tombstone, not on some permanent side effect of having set one.
    await restorePack('p.removed');
    const after = await createCheckout('buyer-rm3', 'p.removed', URLS);
    expect(after.order.orderId).toBeTruthy();
    await __clearPackTombstones();
  });

  it('self-purchase and disabled sellers are refused', async () => {
    await __resetCommerceConnect();
    await sellerWithListing('s1', 'p.f');
    await expect(createCheckout('s1', 'p.f', URLS)).rejects.toMatchObject({ httpStatus: 409 });
    // an un-onboarded seller's listing (no such flow normally, simulate by fresh listing owner)
    await upsertPaidListing('s2', { packName: 'p.g', lane: 'native-paid', priceMajorUnits: 5, currency: 'usd' });
    await setListingApproval('p.g', 'approved');
    await expect(createCheckout('buyer1', 'p.g', URLS)).rejects.toMatchObject({ httpStatus: 409 }); // seller not enabled
  });
});

describe('purchase webhook — exactly-once fulfilment + money-truth guards', () => {
  const sessionEvent = (id: string, orderId: string, over: Record<string, unknown> = {}) => ({
    id, type: 'checkout.session.completed',
    data: { object: { id: 'cs_x', payment_status: 'paid', amount_total: 4000, currency: 'usd', payment_intent: 'pi_1', metadata: { ccOrderId: orderId }, ...over } },
  });

  async function paidOrderSetup(buyer: string, pack: string): Promise<string> {
    await sellerWithListing('s1', pack, 40);
    const started = await createCheckout(buyer, pack, URLS);
    return started.order.orderId;
  }

  it('fulfils exactly once under CONCURRENT duplicate delivery (different event ids)', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrderSetup('buyer1', 'p.h');
    const [a, b] = await Promise.all([
      handleConnectEvent({ event: sessionEvent('evt_a', orderId) }),
      handleConnectEvent({ event: sessionEvent('evt_b', orderId) }),
    ]);
    expect(a.handled && b.handled).toBe(true);
    const order = (await getOrder(orderId))!;
    expect(order.status).toBe('paid');
    expect(order.stripePaymentIntentId).toBe('pi_1');
    expect(await hasPaidOrder('buyer1', 'p.h')).toBe(true);
    const sides = await listOrdersFor('s1');
    expect(sides.sales.map((o) => o.orderId)).toContain(orderId);
  });

  it('ignores a session completed with payment_status unpaid (async methods)', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrderSetup('buyer1', 'p.i');
    await handleConnectEvent({ event: sessionEvent('evt_u', orderId, { payment_status: 'unpaid' }) });
    expect((await getOrder(orderId))!.status).toBe('pending');
  });

  it('refuses an amount mismatch (audited, not applied)', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrderSetup('buyer1', 'p.j');
    await handleConnectEvent({ event: sessionEvent('evt_m', orderId, { amount_total: 999 }) });
    expect((await getOrder(orderId))!.status).toBe('pending');
  });

  it('MONEY-TRUTH: applies a purchase even when the toggle is now OFF', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrderSetup('buyer1', 'p.k');
    await saveConfig({ id: 'commerce-connect', label: 'x', description: 'test', category: 'Admin', status: 'off', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
    try {
      const out = await handleConnectEvent({ event: sessionEvent('evt_t', orderId) });
      expect(out.handled).toBe(true);
      expect((await getOrder(orderId))!.status).toBe('paid');
    } finally {
      await saveConfig({ id: 'commerce-connect', label: 'x', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
    }
  });

  it('payment_intent.succeeded (metadata rides payment_intent_data) also fulfils', async () => {
    await __resetCommerceConnect();
    const orderId = await paidOrderSetup('buyer1', 'p.l');
    const out = await handleConnectEvent({
      event: {
        id: 'evt_pi', type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_9', amount: 4000, currency: 'usd', latest_charge: 'ch_9', metadata: { ccOrderId: orderId } } },
      },
    });
    expect(out.handled).toBe(true);
    const order = (await getOrder(orderId))!;
    expect(order.status).toBe('paid');
    expect(order.stripeChargeId).toBe('ch_9');
  });
});
