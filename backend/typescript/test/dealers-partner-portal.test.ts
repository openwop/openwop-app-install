/**
 * Dealer Network — Phase 2 (deal registration + capability-token partner portal).
 * The public portal: token IS the credential; tenant/org/dealer from the token;
 * uniform 404 on a bad token; partner-safe projection (no internal ids). Internal:
 * registration list + approve/reject (host:dealers:manage; anti-double).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'dealers']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(withCookie = true): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(withCookie && cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (withCookie) for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}
let n = 0;
const B = (orgId: string): string => `/v1/host/openwop-app/dealers/orgs/${encodeURIComponent(orgId)}`;

async function setup(): Promise<{ owner: Client; orgId: string; dealerId: string; tenantId: string }> {
  const tenantId = `org:prm-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const companyId = (await owner.post(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: 'Dealer Co' })).body.companyId;
  const dealerId = (await owner.post(`${B(orgId)}/dealers`, { name: 'North Dealer', companyId, tier: 'Gold' })).body.dealerId;
  await owner.post(`${B(orgId)}/dealers/${dealerId}/outlets`, { name: 'Store A', address: '1 Main St' });
  return { owner, orgId, dealerId, tenantId };
}

describe('dealers PRM — partner portal + registration review', () => {
  it('mints a token; the anonymous partner sees a safe projection + registers a deal; manager approves', async () => {
    const { owner, orgId, dealerId } = await setup();
    const mint = await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`);
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    const token = mint.body.token;
    expect(mint.body.url).toContain(`/partner/${token}`);

    // Anonymous partner (NO session cookie) resolves the token.
    const anon = client(false);
    const portal = await anon.get(`/v1/host/openwop-app/partner/${token}`);
    expect(portal.status, JSON.stringify(portal.body)).toBe(200);
    expect(portal.body.dealer.name).toBe('North Dealer');
    expect(portal.body.outlets).toHaveLength(1);
    // Partner-safe projection: no internal ids / tenant leaked.
    expect(portal.body.dealer.dealerId).toBeUndefined();
    expect(portal.body.tenantId).toBeUndefined();
    expect(portal.body.outlets[0].outletId).toBeUndefined();

    // Partner registers a deal (anonymous, token-scoped).
    const reg = await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Big Fleet Order', companyName: 'Globex' });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect(reg.body.status).toBe('pending');
    expect(reg.body.regId).toBeUndefined(); // internal id not leaked to partner

    // Internal: manager sees the pending registration (the read list is unchanged).
    const list = await owner.get(`${B(orgId)}/registrations`);
    expect(list.body.registrations).toHaveLength(1);
    const regId = list.body.registrations[0].regId;
    expect(list.body.registrations[0].status).toBe('pending');

    // CFP-1 (D9): the DECISION rides the SHARED reviews inbox, not a bespoke page
    // button. Queuing happened automatically when the partner registered (propose →
    // dispose); the manager approves it through the one HITL machinery.
    const reviews = await owner.get('/v1/host/openwop-app/reviews?status=pending');
    const review = reviews.body.items.find((r: any) => r.kind === 'dealer-registration');
    expect(review, JSON.stringify(reviews.body)).toBeTruthy();
    expect(review.summary).toContain('Big Fleet Order');
    const decide = await owner.post(`/v1/host/openwop-app/reviews/${review.reviewId}/actions/approve`);
    expect(decide.status, JSON.stringify(decide.body)).toBe(200);
    expect(decide.body.status).toBe('approved');

    // The applied effect: the registration is approved + stamped, decided through
    // the gate handler (not a naked route).
    const after = await owner.get(`${B(orgId)}/registrations`);
    expect(after.body.registrations[0].status).toBe('approved');
    expect(after.body.registrations[0].decidedBy).toBeTruthy();
    // Anti-double: a resolved review offers no actions, so a re-decide → 422.
    expect((await owner.post(`/v1/host/openwop-app/reviews/${review.reviewId}/actions/reject`)).status).toBe(422);

    // REGRESSION PIN (CFP-1 / D9): the bespoke decision route is DEMOLISHED — a
    // resurrected direct approve/reject mutation no longer exists (404).
    expect((await owner.post(`${B(orgId)}/registrations/${regId}/approve`)).status).toBe(404);
    expect((await owner.post(`${B(orgId)}/registrations/${regId}/reject`)).status).toBe(404);
  });

  it('a bad/absent token 404s uniformly; rotation invalidates the old token', async () => {
    const { owner, orgId, dealerId } = await setup();
    const anon = client(false);
    expect((await anon.get('/v1/host/openwop-app/partner/ptoken:does-not-exist')).status).toBe(404);
    expect((await anon.get('/v1/host/openwop-app/partner/garbage')).status).toBe(404);

    const t1 = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token;
    expect((await anon.get(`/v1/host/openwop-app/partner/${t1}`)).status).toBe(200);
    const t2 = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token; // rotate
    expect(t2).not.toBe(t1);
    expect((await anon.get(`/v1/host/openwop-app/partner/${t1}`)).status).toBe(404); // old token dead
    expect((await anon.get(`/v1/host/openwop-app/partner/${t2}`)).status).toBe(200);
  });

  it('dealer delete cascades registrations + tokens; an orphan token cannot register (DEAL-DATA-1)', async () => {
    const { owner, orgId, dealerId } = await setup();
    const token = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token;
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'D', companyName: 'C' });
    expect((await owner.get(`${B(orgId)}/registrations`)).body.registrations).toHaveLength(1);

    // delete the dealer → PRM data cascades (1 outlet + 1 registration + 1 token + dealer = 4)
    const del = await owner.del(`${B(orgId)}/dealers/${dealerId}`);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBeGreaterThanOrEqual(4);
    // orphan registration no longer lists
    expect((await owner.get(`${B(orgId)}/registrations`)).body.registrations).toHaveLength(0);
    // orphan token: read portal 404s AND the write path can no longer mint new orphans
    expect((await anon.get(`/v1/host/openwop-app/partner/${token}`)).status).toBe(404);
    expect((await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'X', companyName: 'Y' })).status).toBe(404);
  });

  it('deleting the dealer’s CRM company suspends the dealer (DEAL-DATA-2 / ADR 0283)', async () => {
    const { owner, orgId, dealerId } = await setup();
    const companyId = (await owner.get(`${B(orgId)}/dealers/${dealerId}`)).body.companyId;
    expect((await owner.get(`${B(orgId)}/dealers/${dealerId}`)).body.status).toBe('active');
    // delete the CRM company → the crmRecordLifecycle hook suspends the dealer
    expect((await owner.del(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies/${encodeURIComponent(companyId)}`)).status).toBe(204);
    expect((await owner.get(`${B(orgId)}/dealers/${dealerId}`)).body.status).toBe('suspended');
  });

  it('registration review is visible + decidable only to host:dealers:manage', async () => {
    const { owner, orgId, dealerId, tenantId } = await setup();
    const token = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token;
    await client(false).post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'D', companyName: 'C' });

    // The manager (host:dealers:manage) sees the queued dealer-registration review.
    const ownerReviews = await owner.get('/v1/host/openwop-app/reviews?status=pending');
    const review = ownerReviews.body.items.find((r: any) => r.kind === 'dealer-registration');
    expect(review).toBeTruthy();

    // an editor member (workspace:write, no manage) IN THE SAME TENANT cannot see it
    // in the inbox NOR decide it (the reviews visibility narrows to the manage bar,
    // the SAME bar the demolished route enforced — reused here).
    const editor = client();
    const editorId = (await editor.post('/v1/host/openwop-app/test/login', { email: `e-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorId, roles: ['editor'] });
    const editorReviews = await editor.get('/v1/host/openwop-app/reviews?status=pending');
    expect((editorReviews.body.items ?? []).some((r: any) => r.kind === 'dealer-registration')).toBe(false);
    // a direct decide attempt is refused (the review is invisible to them → 404/403)
    expect([403, 404]).toContain((await editor.post(`/v1/host/openwop-app/reviews/${review.reviewId}/actions/approve`)).status);
  });
});
