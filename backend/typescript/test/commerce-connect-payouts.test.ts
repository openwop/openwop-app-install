/**
 * Commerce Connect Phase 3 (ADR 0385) — payout records + seller stats + the
 * seller-stats node pack (manifest↔impl parity rides the repo-wide test; here
 * the node's surface read is exercised end-to-end at the service level).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import {
  __resetCommerceConnect, startOnboarding, syncSellerFromStripe, upsertPaidListing,
  setListingApproval, createCheckout, handleConnectEvent, listPayouts, sellerStats, getSeller,
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

const payoutEvent = (id: string, account: string, over: Record<string, unknown> = {}) => ({
  id, type: 'payout.paid', account,
  data: { object: { id: `po_${id}`, amount: 12345, currency: 'usd', arrival_date: 1_800_000_000, ...over } },
});

describe('payout events → seller payout records', () => {
  it('records payout.paid (minor→major units) and payout.failed; idempotent on payout id', async () => {
    await __resetCommerceConnect();
    await startOnboarding('sp1', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    const acct = (await getSeller('sp1'))!.stripeAccountId;

    expect((await handleConnectEvent({ event: payoutEvent('a', acct) })).handled).toBe(true);
    // re-delivery under a DIFFERENT event id — same payout id, no duplicate
    await handleConnectEvent({ event: payoutEvent('b', acct, { id: 'po_a' }) });
    const rows = await listPayouts('sp1');
    expect(rows.filter((p) => p.payoutId === 'po_a')).toHaveLength(1);
    expect(rows.find((p) => p.payoutId === 'po_a')!.amountMajorUnits).toBeCloseTo(123.45);

    await handleConnectEvent({ event: { ...payoutEvent('c', acct), type: 'payout.failed' } });
    expect((await listPayouts('sp1')).find((p) => p.payoutId === 'po_c')!.status).toBe('failed');
  });

  it('MONEY-TRUTH: payout records apply even when the toggle is OFF', async () => {
    await __resetCommerceConnect();
    await startOnboarding('sp2', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    const acct = (await getSeller('sp2'))!.stripeAccountId;
    await saveConfig({ id: 'commerce-connect', label: 'x', description: 'test', category: 'Admin', status: 'off', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
    try {
      expect((await handleConnectEvent({ event: payoutEvent('t', acct) })).handled).toBe(true);
      expect(await listPayouts('sp2')).toHaveLength(1);
    } finally {
      await saveConfig({ id: 'commerce-connect', label: 'x', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
    }
  });
});

describe('sellerStats — the dashboard/node read', () => {
  it('aggregates paid sales + fees by currency and returns recent payouts', async () => {
    await __resetCommerceConnect();
    await startOnboarding('sv1', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    await syncSellerFromStripe('sv1');
    await upsertPaidListing('sv1', { packName: 'p.stats', lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    await setListingApproval('p.stats', 'approved');
    const { order } = await createCheckout('buyer1', 'p.stats', URLS);
    await handleConnectEvent({
      event: {
        id: 'evt_s', type: 'checkout.session.completed',
        data: { object: { payment_status: 'paid', amount_total: 4000, currency: 'usd', metadata: { ccOrderId: order.orderId } } },
      },
    });
    const acct = (await getSeller('sv1'))!.stripeAccountId;
    await handleConnectEvent({ event: payoutEvent('s', acct) });

    const stats = await sellerStats('sv1');
    expect(stats.seller?.onboardingState).toBe('enabled');
    expect(stats.sales).toMatchObject({ total: 1, paid: 1 });
    expect(stats.sales.grossMajorUnitsByCurrency.usd).toBe(40);
    // CC2-M3 (R3) — EXACT, not toBeCloseTo: minor-units-first aggregation makes
    // the wire figure integral in minor units, and toBeCloseTo is the assertion
    // that would stay green through the float regression this fix closes.
    expect(stats.sales.feesMajorUnitsByCurrency.usd).toBe(4.8);
    expect(stats.recentPayouts).toHaveLength(1);
  });

  it('CC2-M3 — 7 realistic sales aggregate EXACTLY (the float sum this replaces measured 100.24999999999999)', async () => {
    await __resetCommerceConnect();
    await startOnboarding('sv7', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    await syncSellerFromStripe('sv7');
    const amounts = [12.15, 7.05, 6.55, 6.55, 3.35, 13.65, 12.15]; // Σ = 61.45 exactly (in minor units)
    // The guard that makes toBe meaningful — and it took THREE fixtures to get
    // honest: (1) a forward-drifting set probed GREEN because listOrdersFor
    // sorts newest-first (the reverse sum was exact); (2) a fwd+rev-drifting
    // set was still luck — same-millisecond createdAt ties make the sum order
    // ARBITRARY, and 2072 of that set's 5040 permutations sum cleanly. This set
    // was brute-forced so that EVERY permutation of the naive float sum misses
    // 61.45. If a platform ever sums any permutation cleanly, this guard fails
    // and the fixture must be re-derived, not the assertions loosened.
    expect(amounts.reduce((a, b) => a + b, 0)).not.toBe(61.45);
    expect([...amounts].reverse().reduce((a, b) => a + b, 0)).not.toBe(61.45);
    for (let i = 0; i < amounts.length; i += 1) {
      await upsertPaidListing('sv7', { packName: `p.m3.${i}`, lane: 'native-paid', priceMajorUnits: amounts[i]!, currency: 'usd' });
      await setListingApproval(`p.m3.${i}`, 'approved');
      const { order } = await createCheckout(`buyer${i}`, `p.m3.${i}`, URLS);
      await handleConnectEvent({
        event: {
          id: `evt_m3_${i}`, type: 'checkout.session.completed',
          data: { object: { payment_status: 'paid', amount_total: Math.round(amounts[i]! * 100), currency: 'usd', metadata: { ccOrderId: order.orderId } } },
        },
      });
    }
    const stats = await sellerStats('sv7');
    expect(stats.sales.paid).toBe(7);
    expect(stats.sales.grossMajorUnitsByCurrency.usd).toBe(61.45); // exact — integer minor arithmetic
  });

  it('a non-seller tenant gets the empty shape (node-safe)', async () => {
    await __resetCommerceConnect();
    const stats = await sellerStats('nobody');
    expect(stats.seller).toBeNull();
    expect(stats.sales.total).toBe(0);
    expect(stats.recentPayouts).toEqual([]);
  });
});
