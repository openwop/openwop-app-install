/**
 * Commerce Connect Phase 4 (ADR 0385) — ROUTE harness for the listing editor,
 * the superadmin approval queue, and the marketplace pricing annotation:
 * seller-scoped listing upsert (native-paid needs onboarding), approval
 * authority separation (seller cannot approve, 403), and the marketplace
 * /listings projection carrying the pricing annotation for the viewer.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { __resetCommerceConnect } from '../src/features/commerce-connect/connectService.js';
import { listPendingCommerceListingApprovals, setApprovalProposal } from '../src/host/approvalService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // wildcard dev opt-in NOT set → superadmin denied
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await saveConfig({ id: 'commerce-connect', label: 'Commerce Connect', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
  await __resetCommerceConnect();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

async function login(c: Client): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `cc4-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

const CC = '/v1/host/openwop-app/commerce-connect';

describe('listing editor routes', () => {
  it('native-paid listing requires seller onboarding first (409), then saves as pending', async () => {
    const seller = client();
    await login(seller);
    const early = await seller.put(`${CC}/listings/vendor.x.nodes`, { lane: 'native-paid', priceMajorUnits: 25, currency: 'usd' });
    expect(early.status).toBe(409);

    await seller.post(`${CC}/seller/onboard`, {});
    const saved = await seller.put(`${CC}/listings/vendor.x.nodes`, { lane: 'native-paid', priceMajorUnits: 25, currency: 'usd' });
    expect(saved.status).toBe(200);
    expect(saved.body.listing.approvalState).toBe('pending');

    const mine = await seller.get(`${CC}/seller/listings`);
    expect(mine.body.listings.map((l: { packName: string }) => l.packName)).toContain('vendor.x.nodes');

    // another tenant cannot see the pending row in their own listings, nor claim the pack
    const other = client();
    await login(other);
    expect((await other.get(`${CC}/seller/listings`)).body.listings).toHaveLength(0);
    await other.post(`${CC}/seller/onboard`, {});
    expect((await other.put(`${CC}/listings/vendor.x.nodes`, { lane: 'free' })).status).toBe(409);
  });

  it('approval routes are superadmin-only — a seller cannot approve their own listing', async () => {
    const seller = client();
    await login(seller);
    expect((await seller.get(`${CC}/approvals`)).status).toBe(403);
    expect((await seller.post(`${CC}/approvals/vendor.x.nodes`, { decision: 'approved' })).status).toBe(403);
  });

  it('an invalid lane is rejected', async () => {
    const c = client();
    await login(c);
    expect((await c.put(`${CC}/listings/vendor.y.nodes`, { lane: 'nonsense' })).status).toBe(400);
  });
});

describe('CC2-B1 — the approval queue shows what the operator is actually approving', () => {
  it('carries the SELLER and the external payout destination, not just a pack name and a price', async () => {
    // This gate exists (CLAUDE.md) to stop a multi-tenant phishing/squat
    // listing. The queue projection used to return
    // `{approvalId, packName, lane, proposal, createdAt, price?, currency?}` —
    // so an operator approving `feature.crm.nodes (external-link)` could see
    // neither WHO submitted it nor WHERE the money would go. On approve, that
    // URL is annotated onto the browse surface and rendered as "Open external
    // payment" on the pack's card. The destination IS the decision on that lane.
    const seller = client();
    await login(seller);
    const put = await seller.put(`${CC}/listings/vendor.phish.nodes`, {
      lane: 'external-link', externalPaymentUrl: 'https://stripe-checkout-verify.example/pay',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    try {
      const op = client();
      await login(op);
      const queue = await op.get(`${CC}/approvals`);
      expect(queue.status, JSON.stringify(queue.body)).toBe(200);
      const row = (queue.body.pending as Array<Record<string, unknown>>)
        .find((r) => r.packName === 'vendor.phish.nodes');
      expect(row, 'the pending listing should be queued').toBeTruthy();

      expect(row!.externalPaymentUrl, 'the payout destination must be reviewable')
        .toBe('https://stripe-checkout-verify.example/pay');
      expect(row!.sellerTenantId, 'the submitter must be attributable').toBeTruthy();
      // …and the generic inbox lane sees them too, via the proposal string —
      // the operator may never open this feature's own card.
      expect(String(row!.proposal)).toContain('stripe-checkout-verify.example');
      expect(String(row!.proposal)).toContain(String(row!.sellerTenantId));
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    }
  });

  it('a NATIVE-paid listing carries the seller but no destination (the negative control)', async () => {
    // Native-paid moves money through the platform's own Stripe account, so
    // there is no external destination to review. Without this arm, the
    // assertions above are satisfied by a projection that always emits a URL.
    const seller = client();
    await login(seller);
    await seller.post(`${CC}/seller/onboard`, {});
    await seller.put(`${CC}/listings/vendor.native.nodes`, { lane: 'native-paid', priceMajorUnits: 30, currency: 'usd' });

    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    try {
      const op = client();
      await login(op);
      const queue = await op.get(`${CC}/approvals`);
      const row = (queue.body.pending as Array<Record<string, unknown>>)
        .find((r) => r.packName === 'vendor.native.nodes');
      expect(row, 'the native-paid listing should be queued').toBeTruthy();
      expect(row!.externalPaymentUrl).toBeUndefined();
      expect(row!.sellerTenantId).toBeTruthy();
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    }
  });

  it('flags a listing whose pack this host does NOT have (CC2-R1)', async () => {
    // The money gate refuses only a TOMBSTONED pack — absence is ambiguous and
    // refusing on it would take every purchase down whenever the pack directory
    // is briefly unreadable. So the absent half is closed here, at the human
    // gate, where a stale `true` costs a warning instead of an outage.
    const seller = client();
    await login(seller);
    await seller.put(`${CC}/listings/vendor.ghost.nodes`, {
      lane: 'external-link', externalPaymentUrl: 'https://pay.example/ghost',
    });
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    try {
      const op = client();
      await login(op);
      const queue = await op.get(`${CC}/approvals`);
      const row = (queue.body.pending as Array<Record<string, unknown>>)
        .find((r) => r.packName === 'vendor.ghost.nodes');
      expect(row, 'the listing should be queued').toBeTruthy();
      expect(row!.packMissing, 'no such pack on this host').toBe(true);
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    }
  });

  it('refreshes an ALREADY-QUEUED row\'s proposal when the summary improves (CC2-R1)', async () => {
    // `version` hashes lane+price+currency+url, NOT the proposal — so a row
    // queued before the CC2-B1 enrichment kept its seller-less, destination-less
    // summary forever unless the seller happened to make a MATERIAL edit. That
    // is exactly the generic-inbox lane the enrichment exists for.
    const seller = client();
    await login(seller);
    await seller.put(`${CC}/listings/vendor.repin.nodes`, {
      lane: 'external-link', externalPaymentUrl: 'https://pay.example/repin',
    });
    const before = (await listPendingCommerceListingApprovals())
      .find((a) => a.commerceListing?.packName === 'vendor.repin.nodes');
    expect(before).toBeTruthy();

    // Simulate a pre-deploy row: blank the summary, then re-submit IDENTICAL
    // material (the reuse branch — no supersede, same approvalId).
    await setApprovalProposal(before!.approvalId, 'Approve marketplace listing "vendor.repin.nodes" (external-link)');
    await seller.put(`${CC}/listings/vendor.repin.nodes`, {
      lane: 'external-link', externalPaymentUrl: 'https://pay.example/repin',
    });

    const after = (await listPendingCommerceListingApprovals())
      .find((a) => a.commerceListing?.packName === 'vendor.repin.nodes');
    expect(after!.approvalId, 'the row is REUSED, not superseded').toBe(before!.approvalId);
    expect(after!.proposal, 'the destination reaches the generic inbox lane').toContain('pay.example/repin');
    expect(after!.commerceListing?.version, 'the MATERIAL fingerprint is untouched')
      .toBe(before!.commerceListing?.version);
  });
});

describe('listing approval rides the shared approvals owner (chat-first-port F3)', () => {
  it('a pending listing produces a shared commerce-listing-publish row; a superadmin decide flips it via the shared path; a material edit supersedes it', async () => {
    const seller = client();
    await login(seller);
    await seller.post(`${CC}/seller/onboard`, {});
    const saved = await seller.put(`${CC}/listings/vendor.share.nodes`, { lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    expect(saved.body.listing.approvalState).toBe('pending');

    // The SHARED approval row exists (not a private-only flag).
    const rows = await listPendingCommerceListingApprovals();
    const row = rows.find((a) => a.commerceListing?.packName === 'vendor.share.nodes');
    expect(row, 'a shared commerce-listing-publish approval must exist').toBeTruthy();

    // A non-superadmin cannot mint a decision on the shared row.
    expect((await seller.post(`${CC}/approvals/${row!.approvalId}`, { decision: 'approved' })).status).toBe(403);

    // A material edit supersedes the stale row and queues a fresh one.
    await seller.put(`${CC}/listings/vendor.share.nodes`, { lane: 'native-paid', priceMajorUnits: 55, currency: 'usd' });
    const rows2 = await listPendingCommerceListingApprovals();
    const rows2ForPack = rows2.filter((a) => a.commerceListing?.packName === 'vendor.share.nodes');
    expect(rows2ForPack.length, 'exactly one pending row per pack').toBe(1);
    expect(rows2ForPack[0].approvalId).not.toBe(row!.approvalId);

    // A superadmin resolves the CURRENT row through the shared decision core →
    // the listing's approvalState mirror flips, and the row leaves the queue.
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    try {
      const op = client();
      await login(op);
      const decide = await op.post(`${CC}/approvals/${rows2ForPack[0].approvalId}`, { decision: 'approved' });
      expect(decide.status, JSON.stringify(decide.body)).toBe(200);
      expect(decide.body.status).toBe('approved');
      const mine = await seller.get(`${CC}/seller/listings`);
      const listing = (mine.body.listings as { packName: string; approvalState?: string }[]).find((l) => l.packName === 'vendor.share.nodes');
      expect(listing?.approvalState).toBe('approved');
      const rows3 = await listPendingCommerceListingApprovals();
      expect(rows3.some((a) => a.commerceListing?.packName === 'vendor.share.nodes')).toBe(false);
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    }
  });

  /**
   * MKT-UX-7 — a rejection carries a REASON, end to end.
   *
   * The decide route parsed `{ decision }` only, so "Rejected" was the entire
   * feedback the seller received and the reason did not exist anywhere in the
   * system — not on the wire, not on the approval row, not on the listing. The
   * `resolveApproval` core already accepted a `note`; the route never populated
   * it. Tracing the path the refusal prescribed: there wasn't one.
   */
  it('a rejection REQUIRES a reason, and the reason reaches the SELLER on their own row', async () => {
    const seller = client();
    await login(seller);
    await seller.post(`${CC}/seller/onboard`, {});
    await seller.put(`${CC}/listings/vendor.reason.nodes`, { lane: 'native-paid', priceMajorUnits: 40, currency: 'usd' });
    const row = (await listPendingCommerceListingApprovals())
      .find((a) => a.commerceListing?.packName === 'vendor.reason.nodes')!;

    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    try {
      const op = client();
      await login(op);

      // A reasonless rejection is a 400 — the refusal itself must not be a dead end.
      const bare = await op.post(`${CC}/approvals/${row.approvalId}`, { decision: 'rejected' });
      expect(bare.status, JSON.stringify(bare.body)).toBe(400);
      expect(bare.body.details?.field).toBe('reason');
      // …and it did NOT consume the approval.
      expect((await listPendingCommerceListingApprovals()).some((a) => a.approvalId === row.approvalId)).toBe(true);

      const reason = 'The payout URL is not on your verified domain.';
      const done = await op.post(`${CC}/approvals/${row.approvalId}`, { decision: 'rejected', reason });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.status).toBe('rejected');

      // The seller reads it from THEIR route — they cannot read approval rows.
      const mine = await seller.get(`${CC}/seller/listings`);
      const listing = (mine.body.listings as { packName: string; approvalState?: string; approvalNote?: string }[])
        .find((l) => l.packName === 'vendor.reason.nodes');
      expect(listing?.approvalState).toBe('rejected');
      expect(listing?.approvalNote, 'the seller must be able to READ the reason').toBe(reason);
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    }
  });

  it('an APPROVAL still works without a reason (the requirement is scoped to rejection)', async () => {
    const seller = client();
    await login(seller);
    await seller.post(`${CC}/seller/onboard`, {});
    await seller.put(`${CC}/listings/vendor.noreason.nodes`, { lane: 'native-paid', priceMajorUnits: 12, currency: 'usd' });
    const row = (await listPendingCommerceListingApprovals())
      .find((a) => a.commerceListing?.packName === 'vendor.noreason.nodes')!;
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    try {
      const op = client();
      await login(op);
      const done = await op.post(`${CC}/approvals/${row.approvalId}`, { decision: 'approved' });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    }
  });
});

describe('marketplace /listings pricing annotation', () => {
  it('the marketplace projection is unaffected for tenants when no paid row exists (provider returns empty)', async () => {
    await saveConfig({ id: 'marketplace', label: 'Marketplace', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'marketplace' }, 'test');
    const c = client();
    await login(c);
    const r = await c.get('/v1/host/openwop-app/marketplace/listings');
    expect(r.status).toBe(200);
    for (const l of r.body.listings as { pricing?: unknown }[]) expect(l.pricing).toBeUndefined();
  });
});
