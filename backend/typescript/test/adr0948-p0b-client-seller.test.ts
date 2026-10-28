/**
 * ADR 0948 P0b — each CLIENT org of an agency workspace settles through its OWN
 * Connect seller (David, 2026-10-19, #5038).
 *
 *  - The resolver reads ONLY the client's seller: absent → `client_seller_required`,
 *    half-onboarded → its own not-ready reason, ready → `connect` with the CLIENT's
 *    account — even while the agency's seller is ready; never the agency's account.
 *  - The account binding is (tenant, org): the agency's account cannot be bound to a
 *    client, nor the reverse.
 *  - A Connect webhook for a client's account updates only the client's row (and the
 *    reverse); a payout is attributed to the client org.
 *  - Onboarding a client org mints its own row and placeholder; the tenant's seller is
 *    untouched.
 *  - Routes: choosing where a client's money is paid out is owner-only
 *    (`host:org:manage`) on the client org: its owner may onboard; an editor, an admin,
 *    or an agency owner who is not a member there is 403; the workspace root gets
 *    `400 not_a_client_org`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { removeSecret, setSecret } from '../src/byok/secretResolver.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { resolveStorefrontSettlement } from '../src/features/commerce-connect/storefrontSettlement.js';
import { sellers, clientSellers, accountIndex, payouts, bindSellerAccount, sellerRows, type SellerAccount } from '../src/features/commerce-connect/stores.js';
import { listPayouts } from '../src/features/commerce-connect/orders.js';
import { importSellers, reconcileSellerBindings } from '../src/features/commerce-connect/adminOps.js';
import { startOnboarding, syncSellerFromStripe, getSeller } from '../src/features/commerce-connect/onboarding.js';
import { handleConnectEvent } from '../src/features/commerce-connect/webhookHandlers.js';

let BASE = ''; let server: http.Server; let n = 0;
let stripe: http.Server;
let stripeCalls: Array<{ path: string; body: string }> = [];
let accountsMinted = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['commerce', 'commerce-connect']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
beforeAll(async () => {
  // A mock Stripe (the commerce-connect-live-lane precedent): each account create
  // mints a fresh id, slowly enough that two concurrent onboards overlap.
  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      stripeCalls.push({ path, body: raw });
      const send = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && path.endsWith('/accounts')) { const id = `acct_live_${++accountsMinted}`; setTimeout(() => send(200, { id, country: 'US' }), 30); return; }
      if (path.endsWith('/account_links')) return send(200, { url: 'https://connect.stripe.com/setup/x' });
      const m = /\/accounts\/([^/?]+)$/.exec(path); // Stripe's own API paths
      if (m) return send(200, { id: m[1], charges_enabled: true, payouts_enabled: true, details_submitted: true, country: 'US', capabilities: { card_payments: 'active', transfers: 'active' } });
      send(404, {});
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.OPENWOP_STRIPE_API_BASE;
  await removeSecret('billing:stripe-key').catch(() => undefined);
  await new Promise<void>((r) => stripe.close(() => r()));
  await new Promise<void>((res) => server.close(() => res()));
});

const now = (): string => new Date().toISOString();
function ready(over: Partial<SellerAccount>): SellerAccount {
  return { tenantId: '', stripeAccountId: '', onboardingState: 'enabled', chargesEnabled: true, payoutsEnabled: true, region: 'US', capabilities: ['card_payments', 'transfers'], mode: 'live', createdAt: now(), updatedAt: now(), ...over };
}
async function agency(): Promise<{ T: string; client: string; other: string }> {
  const ws = await createWorkspace({ name: `Agency ${n++}`, ownerSubject: `oidc:p0b-owner-${n}` });
  const client = (await createOrg({ tenantId: ws.tenantId, createdBy: 'seed', name: 'Client A' })).orgId;
  const other = (await createOrg({ tenantId: ws.tenantId, createdBy: 'seed', name: 'Client B' })).orgId;
  return { T: ws.tenantId, client, other };
}
async function errorOf(p: Promise<unknown>): Promise<{ status: number; reason?: unknown }> {
  try { await p; return { status: 0 }; } catch (e) {
    const err = e as { httpStatus?: number; details?: { reason?: unknown } };
    return { status: err.httpStatus ?? -1, reason: err.details?.reason };
  }
}

describe('ADR 0948 P0b — a client org settles only through its own seller', () => {
  it('only one competing agency or client can acquire a previously unbound Stripe account', async () => {
    const { T, client, other } = await agency();
    const account = `acct_racing_bind_${n++}`;
    const orgs = [undefined, client, other];
    const results = await Promise.allSettled(orgs.map((orgId) => bindSellerAccount(T, account, orgId)));
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ httpStatus: 409, details: { reason: 'binding_conflict' } });
    }
    expect(await accountIndex.get(account)).toEqual({ stripeAccountId: account, tenantId: T, ...(orgs[winner] ? { orgId: orgs[winner] } : {}) });
    await bindSellerAccount(T, account, orgs[winner]);
    expect(await accountIndex.get(account)).toMatchObject({ tenantId: T, stripeAccountId: account });
  });

  it('absent → client_seller_required; half-onboarded → its own reason; ready → the CLIENT account, never the agency', async () => {
    await setSecret('billing:stripe-key', 'sk_test_mock');
    const { T, client } = await agency();
    const agencyAcct = `acct_agency_${n++}`;
    await sellers.put(ready({ tenantId: T, stripeAccountId: agencyAcct }));
    await bindSellerAccount(T, agencyAcct);
    expect(await resolveStorefrontSettlement(T, T)).toMatchObject({ kind: 'connect', destinationAccountId: agencyAcct });
    expect(await resolveStorefrontSettlement(T, client)).toEqual({ kind: 'demo', reason: 'client_seller_required' });

    const clientAcct = `acct_client_${n++}`;
    await clientSellers.put(ready({ tenantId: T, orgId: client, stripeAccountId: clientAcct, onboardingState: 'pending', chargesEnabled: false }));
    expect(await resolveStorefrontSettlement(T, client)).toEqual({ kind: 'demo', reason: 'connect_incomplete' });

    await clientSellers.put(ready({ tenantId: T, orgId: client, stripeAccountId: clientAcct }));
    // Ready but not yet bound: the binding is what attributes the account's
    // webhooks, so an unbound account is never a charge destination.
    expect(await resolveStorefrontSettlement(T, client)).toEqual({ kind: 'demo', reason: 'connect_incomplete' });
    await bindSellerAccount(T, clientAcct, client);
    const lane = await resolveStorefrontSettlement(T, client);
    expect(lane).toMatchObject({ kind: 'connect', destinationAccountId: clientAcct });
    // The agency's lane is unchanged by the client's onboarding.
    expect(await resolveStorefrontSettlement(T, T)).toMatchObject({ kind: 'connect', destinationAccountId: agencyAcct });
  });

  it("the binding is (tenant, org): the agency's account can't become a client's, nor the reverse", async () => {
    const { T, client, other } = await agency();
    const a = `acct_bind_${n++}`;
    await bindSellerAccount(T, a);
    expect(await errorOf(bindSellerAccount(T, a, client))).toEqual({ status: 409, reason: 'binding_conflict' });
    const c = `acct_bind_${n++}`;
    await bindSellerAccount(T, c, client);
    expect(await errorOf(bindSellerAccount(T, c))).toEqual({ status: 409, reason: 'binding_conflict' });
    expect(await errorOf(bindSellerAccount(T, c, other))).toEqual({ status: 409, reason: 'binding_conflict' });
    await bindSellerAccount(T, c, client); // same (tenant, org): idempotent
    expect(await accountIndex.get(c)).toEqual({ stripeAccountId: c, tenantId: T, orgId: client });
  });

  it("a client account's webhook updates only the client's row; a payout is attributed to the client", async () => {
    const { T, client } = await agency();
    const agencyAcct = `acct_wa_${n++}`; const clientAcct = `acct_wc_${n++}`;
    await sellers.put(ready({ tenantId: T, stripeAccountId: agencyAcct }));
    await bindSellerAccount(T, agencyAcct);
    await clientSellers.put(ready({ tenantId: T, orgId: client, stripeAccountId: clientAcct, onboardingState: 'pending', chargesEnabled: false, capabilities: [] }));
    await bindSellerAccount(T, clientAcct, client);

    const ev = (id: string, account: string, type: string, object: Record<string, unknown>) =>
      ({ event: { id, type, account, data: { object } } }) as Parameters<typeof handleConnectEvent>[0];
    expect(await handleConnectEvent(ev(`evt_${n++}`, clientAcct, 'account.updated', { charges_enabled: true, payouts_enabled: true, country: 'US', capabilities: { card_payments: 'active', transfers: 'active' } }))).toEqual({ handled: true });
    expect(await getSeller(T, client)).toMatchObject({ onboardingState: 'enabled', chargesEnabled: true });
    expect(await getSeller(T)).toMatchObject({ stripeAccountId: agencyAcct, onboardingState: 'enabled' });

    await handleConnectEvent(ev(`evt_${n++}`, agencyAcct, 'account.application.deauthorized', {}));
    expect(await getSeller(T)).toMatchObject({ onboardingState: 'deauthorized' });
    expect(await getSeller(T, client)).toMatchObject({ onboardingState: 'enabled' }); // the client is untouched

    const payoutId = `po_${n++}`;
    await handleConnectEvent(ev(`evt_${n++}`, clientAcct, 'payout.paid', { id: payoutId, amount: 1234, currency: 'usd' }));
    expect(await payouts.get(payoutId)).toMatchObject({ tenantId: T, orgId: client, status: 'paid' });
  });

  it('onboarding a client org mints its OWN row and placeholder; the tenant seller is untouched', async () => {
    await removeSecret('billing:stripe-key'); // the demo lane: no Stripe call
    const { T, client } = await agency();
    const out = await startOnboarding(T, { returnUrl: 'https://x/r', refreshUrl: 'https://x/f' }, {}, client);
    expect(out.mode).toBe('demo');
    expect(out.seller).toMatchObject({ tenantId: T, orgId: client, stripeAccountId: `acct_demo_${T}__${client}` });
    expect(await getSeller(T)).toBeNull();
    expect(await accountIndex.get(`acct_demo_${T}__${client}`)).toEqual({ stripeAccountId: `acct_demo_${T}__${client}`, tenantId: T, orgId: client });
    const synced = await syncSellerFromStripe(T, client);
    expect(synced).toMatchObject({ orgId: client, onboardingState: 'enabled' });
    expect(await getSeller(T)).toBeNull();
  });
});

describe('ADR 0948 P0b — the live lane and the tenant-lane readers', () => {
  it('live: two concurrent client onboards create ONE Stripe account, tagged with the client org; sync makes it the client lane', async () => {
    await setSecret('billing:stripe-key', 'sk_test_mock');
    const { T, client } = await agency();
    stripeCalls = [];
    const urls = { returnUrl: 'https://x/r', refreshUrl: 'https://x/f' };
    const both = await Promise.allSettled([startOnboarding(T, urls, {}, client), startOnboarding(T, urls, {}, client)]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(both.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.httpStatus)).toEqual([409]);
    const created = stripeCalls.filter((c) => c.path.endsWith('/accounts'));
    expect(created).toHaveLength(1);
    expect(decodeURIComponent(created[0]!.body)).toContain(`metadata[orgId]=${client}`);
    const seller = (await getSeller(T, client))!;
    expect(seller).toMatchObject({ tenantId: T, orgId: client, mode: 'live' });
    expect(seller.stripeAccountId).toMatch(/^acct_live_/);
    expect(await accountIndex.get(seller.stripeAccountId)).toEqual({ stripeAccountId: seller.stripeAccountId, tenantId: T, orgId: client });
    await syncSellerFromStripe(T, client);
    expect(await resolveStorefrontSettlement(T, client)).toMatchObject({ kind: 'connect', destinationAccountId: seller.stripeAccountId });
    expect(await getSeller(T)).toBeNull();
  });

  it("the tenant's payout list excludes a client org's payouts; the org filter selects exactly that seller's", async () => {
    const { T, client } = await agency();
    const base = { tenantId: T, amountMajorUnits: 1, currency: 'usd', status: 'paid' as const, createdAt: now() };
    await payouts.put({ ...base, payoutId: `po_t_${n++}` });
    const clientPayout = `po_c_${n++}`;
    await payouts.put({ ...base, payoutId: clientPayout, orgId: client });
    expect((await listPayouts(T)).map((p) => p.payoutId)).not.toContain(clientPayout);
    expect((await listPayouts(T, 20, client)).map((p) => p.payoutId)).toEqual([clientPayout]);
  });

  it("the operator import refuses an account bound to a client org, and writes no agency row", async () => {
    const { T, client } = await agency();
    const acct = `acct_imp_${n++}`;
    await bindSellerAccount(T, acct, client);
    const out = await importSellers([{ tenantId: T, stripeAccountId: acct }]);
    expect(out).toMatchObject({ sellers: 0, rejected: [{ tenantId: T, reason: 'account_already_bound' }] });
    expect(await getSeller(T)).toBeNull();
  });

  it('reconciliation checks a client binding against the client seller, not the agency', async () => {
    const { T, client } = await agency();
    const acct = `acct_rec_${n++}`;
    await clientSellers.put(ready({ tenantId: T, orgId: client, stripeAccountId: acct }));
    await bindSellerAccount(T, acct, client);
    const before = await reconcileSellerBindings();
    await clientSellers.delete(`${T}::${client}`);
    const after = await reconcileSellerBindings();
    expect(after.divergent - before.divergent).toBe(1); // only the removed row diverges
  });

  it('only a client org has a client seller: a root org is refused, not silently given one', async () => {
    const { T } = await agency();
    expect(() => sellerRows({ tenantId: T, orgId: T })).toThrow(/client organization/);
  });
});

async function session(tenantId: string, principal: string): Promise<string> {
  const u = await upsertFromPrincipal({ tenantId, principalId: principal, source: 'oidc' });
  const t = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId, tier: 'user', userId: u.userId, personalTenant: `ws:home-${n++}`, iat: t, exp: t + COOKIE_TTL_SECONDS })}`;
}
async function getAs(cookie: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
async function postAs(cookie: string, path: string): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: BASE }, body: '{}' });
  const text = await res.text();
  const body: { details?: { code?: string } } = text ? JSON.parse(text) : {};
  return { status: res.status, code: body.details?.code };
}

describe('ADR 0948 P0b — the client-seller routes', () => {
  it('the client org owner onboards; an editor, an admin or a non-member agency owner is 403; the root is not_a_client_org', async () => {
    await removeSecret('billing:stripe-key');
    const { T, client } = await agency();
    const adminPrincipal = `oidc:p0b-admin-${n++}`;
    const adminCookie = await session(T, adminPrincipal);
    const adminUser = (await upsertFromPrincipal({ tenantId: T, principalId: adminPrincipal, source: 'oidc' })).userId;
    await createMember({ tenantId: T, orgId: T, subject: adminUser, displayName: 'Agency admin', roles: ['viewer'] });
    await createMember({ tenantId: T, orgId: client, subject: adminUser, displayName: 'Client owner', roles: ['owner'] });
    const editorPrincipal = `oidc:p0b-editor-${n++}`;
    const editorCookie = await session(T, editorPrincipal);
    const editorUser = (await upsertFromPrincipal({ tenantId: T, principalId: editorPrincipal, source: 'oidc' })).userId;
    await createMember({ tenantId: T, orgId: T, subject: editorUser, displayName: 'Editor', roles: ['viewer'] });
    await createMember({ tenantId: T, orgId: client, subject: editorUser, displayName: 'Editor', roles: ['editor'] });

    const onboard = (org: string): string => `/host/openwop-app/commerce-connect/orgs/${encodeURIComponent(org)}/seller/onboard`;
    expect((await postAs(editorCookie, onboard(client))).status).toBe(403);
    const ok = await postAs(adminCookie, onboard(client));
    expect(ok.status, JSON.stringify(ok)).toBe(201);
    expect(await getSeller(T, client)).toMatchObject({ orgId: client, mode: 'demo' });
    expect(await getSeller(T)).toBeNull();

    // A client-org ADMIN cannot pick where the client's money goes (owner-only, host:org:manage).
    const clientAdminP = `oidc:p0b-cadmin-${n++}`;
    const clientAdminCookie = await session(T, clientAdminP);
    const clientAdmin = (await upsertFromPrincipal({ tenantId: T, principalId: clientAdminP, source: 'oidc' })).userId;
    await createMember({ tenantId: T, orgId: T, subject: clientAdmin, displayName: 'Viewer', roles: ['viewer'] });
    await createMember({ tenantId: T, orgId: client, subject: clientAdmin, displayName: 'Client admin', roles: ['admin'] });
    expect((await postAs(clientAdminCookie, onboard(client))).status).toBe(403);

    // The agency owner holds no authority INSIDE a client org unless it is a member
    // there (ADR 0815 D1b: an org-scoped check reads that org's membership). This
    // route does not widen that: to set up a client's payments, be its owner.
    const owner = `oidc:p0b-rootowner-${n++}`;
    const rootCookie = await session(T, owner);
    const rootUser = (await upsertFromPrincipal({ tenantId: T, principalId: owner, source: 'oidc' })).userId;
    await createMember({ tenantId: T, orgId: T, subject: rootUser, displayName: 'Agency owner', roles: ['owner'] });
    expect((await postAs(rootCookie, onboard(client))).status).toBe(403);
    // The workspace root uses the tenant routes; the client route refuses it.
    expect(await postAs(rootCookie, onboard(T))).toEqual({ status: 400, code: 'not_a_client_org' });

    // The read: the client's owner sees the client's seller, never the agency's.
    const read = await getAs(adminCookie, `/host/openwop-app/commerce-connect/orgs/${encodeURIComponent(client)}/seller`);
    expect(read.status).toBe(200);
    expect(read.body.seller).toMatchObject({ orgId: client, mode: 'demo' });
    // An org of ANOTHER workspace is refused as absent, never served.
    const elsewhere = await agency();
    expect((await getAs(adminCookie, `/host/openwop-app/commerce-connect/orgs/${encodeURIComponent(elsewhere.client)}/seller`)).status).toBe(404);

    // Readiness tells the page who can act: the owner may onboard, the editor may not.
    const payments = (cookie: string) => getAs(cookie, `/host/openwop-app/commerce/orgs/${encodeURIComponent(client)}/payments`);
    await setSecret('billing:stripe-key', 'sk_test_mock');
    expect((await payments(adminCookie)).body).toMatchObject({ clientOrg: true, canOnboardClient: true });
    expect((await payments(editorCookie)).body).toMatchObject({ clientOrg: true, canOnboardClient: false });
    await removeSecret('billing:stripe-key');
  });
});

describe('ADR 0948 P0b — integration hardening (charge only on a confirmed binding; deauthorization; anon)', () => {
  it('a ready seller whose account is bound to ANOTHER seller never takes the charge (client and tenant lanes)', async () => {
    await setSecret('billing:stripe-key', 'sk_test_mock');
    const { T, client, other } = await agency();
    const acct = `acct_elsewhere_${n++}`;
    await bindSellerAccount(T, acct, other); // the account belongs to client B
    await clientSellers.put(ready({ tenantId: T, orgId: client, stripeAccountId: acct })); // client A's row names it
    expect(await resolveStorefrontSettlement(T, client)).toEqual({ kind: 'demo', reason: 'connect_incomplete' });
    await sellers.put(ready({ tenantId: T, stripeAccountId: acct })); // the agency's row names it too
    expect(await resolveStorefrontSettlement(T, T)).toEqual({ kind: 'demo', reason: 'connect_incomplete' });
    // Client B, the binding's owner, settles on it once its own row is ready.
    await clientSellers.put(ready({ tenantId: T, orgId: other, stripeAccountId: acct }));
    expect(await resolveStorefrontSettlement(T, other)).toMatchObject({ kind: 'connect', destinationAccountId: acct });
  });

  it('a deauthorized client account stops taking charges at once; the agency lane is unaffected', async () => {
    await setSecret('billing:stripe-key', 'sk_test_mock');
    const { T, client } = await agency();
    const agencyAcct = `acct_da_agency_${n++}`; const clientAcct = `acct_da_client_${n++}`;
    await sellers.put(ready({ tenantId: T, stripeAccountId: agencyAcct }));
    await bindSellerAccount(T, agencyAcct);
    await clientSellers.put(ready({ tenantId: T, orgId: client, stripeAccountId: clientAcct }));
    await bindSellerAccount(T, clientAcct, client);
    expect(await resolveStorefrontSettlement(T, client)).toMatchObject({ kind: 'connect', destinationAccountId: clientAcct });

    const ev = (type: string, object: Record<string, unknown>) =>
      ({ event: { id: `evt_da_${n++}`, type, account: clientAcct, data: { object } } }) as Parameters<typeof handleConnectEvent>[0];
    expect(await handleConnectEvent(ev('account.application.deauthorized', {}))).toEqual({ handled: true });
    expect(await getSeller(T, client)).toMatchObject({ onboardingState: 'deauthorized', chargesEnabled: false });
    const after = await resolveStorefrontSettlement(T, client);
    expect(after.kind, 'never the agency account, never the platform').toBe('demo');
    expect(await resolveStorefrontSettlement(T, T)).toMatchObject({ kind: 'connect', destinationAccountId: agencyAcct });

    // A later account.updated that disables charges keeps it demo too.
    await clientSellers.put(ready({ tenantId: T, orgId: client, stripeAccountId: clientAcct }));
    await handleConnectEvent(ev('account.updated', { charges_enabled: false, payouts_enabled: false, country: 'US', capabilities: { card_payments: 'inactive', transfers: 'inactive' } }));
    expect((await resolveStorefrontSettlement(T, client)).kind).toBe('demo');
  });

  it('an anon: tenant can never onboard a client seller, and its client lane is demo/anon', async () => {
    await setSecret('billing:stripe-key', 'sk_test_mock');
    const anonT = `anon:p0b-${n++}`;
    await expect(startOnboarding(anonT, { refreshUrl: 'https://x/r', returnUrl: 'https://x/s' }, {}, 'org-anything')).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'anon_tenant' } });
    expect(await clientSellers.list().then((rows) => rows.filter((r) => r.tenantId === anonT))).toEqual([]);
    expect(await resolveStorefrontSettlement(anonT, 'org-anything')).toEqual({ kind: 'demo', reason: 'anon' });
  });
});
