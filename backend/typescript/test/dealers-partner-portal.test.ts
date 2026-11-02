/**
 * Dealer Network — Phase 2 (deal registration + capability-token partner portal).
 * The public portal: token IS the credential; tenant/org/dealer from the token;
 * uniform 404 on a bad token; partner-safe projection (no internal ids). Internal:
 * registration list + approve/reject (host:dealers:manage; anti-double).
 *
 * TST-CUD-3. Red when the portal projection leaks internal ids (dealer or created
 * registration), when rotation keeps the old token alive, when the dealer delete
 * stops cascading registrations or tokens, when a CRM company delete stops
 * suspending its dealer, or when the review audience drops host:dealers:manage.
 * DOUBLE GUARDS (recorded):
 *  - a non-manager is kept off a dealer-registration review twice: the reviews
 *    AUDIENCE filter (`approvalAudience.ts`, orgScope host:dealers:manage) hides it,
 *    so the decide route 404s before the decision gate (`registrationApproval.ts`)
 *    is reached. The probe aims at the outer guard, the audience.
 *  - an orphan partner token is refused twice: the cascade deletes it, and both
 *    partner routes also 404 on the missing dealer. The token cascade is asserted
 *    directly through `resolvePartnerToken`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { resolvePartnerToken, type DealRegistration } from '../src/features/dealers/entities/registration.js';

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

interface Res<T> { status: number; body: T }
interface Review { kind: string; reviewId: string; summary: string }
/** The union of the response fields these routes return (each call reads only its own). */
interface Body {
  error: string; message: string; status: string;
  user: { userId: string }; orgId: string; companyId: string; dealerId: string;
  token: string; url: string; removed: number; tenantId?: string; regId?: string;
  dealer: { name: string; tier: string; status: string; dealerId?: string };
  outlets: Array<{ name: string; outletId?: string }>;
  registrations: DealRegistration[];
  items: Review[];
}
interface Client { get: (p: string) => Promise<Res<Body>>; post: (p: string, b?: unknown) => Promise<Res<Body>>; del: (p: string) => Promise<Res<Body>> }
function client(withCookie = true): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<Body>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(withCookie && cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (withCookie) for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}
let n = 0;
const B = (orgId: string): string => `/host/openwop-app/dealers/orgs/${encodeURIComponent(orgId)}`;

async function setup(): Promise<{ owner: Client; orgId: string; dealerId: string; tenantId: string }> {
  const tenantId = `org:prm-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const companyId = (await owner.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: 'Dealer Co' })).body.companyId;
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
    const portal = await anon.get(`/host/openwop-app/partner/${token}`);
    expect(portal.status, JSON.stringify(portal.body)).toBe(200);
    expect(portal.body.dealer.name).toBe('North Dealer');
    expect(portal.body.outlets).toHaveLength(1);
    // Partner-safe projection: no internal ids / tenant leaked.
    expect(portal.body.dealer.dealerId).toBeUndefined();
    expect(portal.body.tenantId).toBeUndefined();
    expect(portal.body.outlets[0]!.outletId).toBeUndefined();

    // Partner registers a deal (anonymous, token-scoped).
    const reg = await anon.post(`/host/openwop-app/partner/${token}/register`, { dealTitle: 'Big Fleet Order', companyName: 'Globex' });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect(reg.body.status).toBe('pending');
    expect(reg.body.regId).toBeUndefined(); // internal id not leaked to partner

    // Internal: manager sees the pending registration (the read list is unchanged).
    const list = await owner.get(`${B(orgId)}/registrations`);
    expect(list.body.registrations).toHaveLength(1);
    const regId = list.body.registrations[0]!.regId;
    expect(list.body.registrations[0]!.status).toBe('pending');

    // CFP-1 (D9): the DECISION rides the SHARED reviews inbox, not a bespoke page
    // button. Queuing happened automatically when the partner registered (propose →
    // dispose); the manager approves it through the one HITL machinery.
    const reviews = await owner.get('/host/openwop-app/reviews?status=pending');
    const review = reviews.body.items.find((r) => r.kind === 'dealer-registration');
    if (!review) throw new Error(`no dealer-registration review: ${JSON.stringify(reviews.body)}`);
    expect(review.summary).toContain('Big Fleet Order');
    const decide = await owner.post(`/host/openwop-app/reviews/${review.reviewId}/actions/approve`);
    expect(decide.status, JSON.stringify(decide.body)).toBe(200);
    expect(decide.body.status).toBe('approved');

    // The applied effect: the registration is approved + stamped, decided through
    // the gate handler (not a naked route).
    const after = await owner.get(`${B(orgId)}/registrations`);
    expect(after.body.registrations[0]!.status).toBe('approved');
    expect(after.body.registrations[0]!.decidedBy).toBeTruthy();
    // Anti-double: a resolved review offers no actions, so a re-decide → 422.
    expect((await owner.post(`/host/openwop-app/reviews/${review.reviewId}/actions/reject`)).status).toBe(422);

    // REGRESSION PIN (CFP-1 / D9): the bespoke decision route is DEMOLISHED — a
    // resurrected direct approve/reject mutation no longer exists (404).
    expect((await owner.post(`${B(orgId)}/registrations/${regId}/approve`)).status).toBe(404);
    expect((await owner.post(`${B(orgId)}/registrations/${regId}/reject`)).status).toBe(404);
  });

  it('a bad/absent token 404s uniformly; rotation invalidates the old token', async () => {
    const { owner, orgId, dealerId } = await setup();
    const anon = client(false);
    const unknown = await anon.get('/host/openwop-app/partner/ptoken:does-not-exist');
    const garbage = await anon.get('/host/openwop-app/partner/garbage');
    expect(unknown.status).toBe(404);
    expect(garbage.status).toBe(404);
    // uniform: the two refusals are byte-identical (no shape oracle)
    expect(JSON.stringify(garbage.body)).toBe(JSON.stringify(unknown.body));
    expect(unknown.body.message).toBe('Invalid partner link.');

    const t1 = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token;
    expect((await anon.get(`/host/openwop-app/partner/${t1}`)).status).toBe(200);
    const t2 = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token; // rotate
    expect(t2).not.toBe(t1);
    const dead = await anon.get(`/host/openwop-app/partner/${t1}`); // old token dead — same uniform 404
    expect(dead.status).toBe(404);
    expect(JSON.stringify(dead.body)).toBe(JSON.stringify(unknown.body));
    expect((await anon.get(`/host/openwop-app/partner/${t2}`)).status).toBe(200);
  });

  it('dealer delete cascades registrations + tokens; an orphan token cannot register (DEAL-DATA-1)', async () => {
    const { owner, orgId, dealerId } = await setup();
    const token = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token;
    const anon = client(false);
    await anon.post(`/host/openwop-app/partner/${token}/register`, { dealTitle: 'D', companyName: 'C' });
    expect((await owner.get(`${B(orgId)}/registrations`)).body.registrations).toHaveLength(1);

    // delete the dealer → PRM data cascades (1 outlet + 1 registration + 1 token + dealer = 4)
    const del = await owner.del(`${B(orgId)}/dealers/${dealerId}`);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(4);
    // the token row itself is gone (asserted directly: the partner routes would 404
    // on the missing dealer even if the token survived — see the header)
    await expect(resolvePartnerToken(token)).rejects.toMatchObject({ code: 'not_found' });
    // orphan registration no longer lists
    expect((await owner.get(`${B(orgId)}/registrations`)).body.registrations).toHaveLength(0);
    // orphan token: read portal 404s AND the write path can no longer mint new orphans
    expect((await anon.get(`/host/openwop-app/partner/${token}`)).status).toBe(404);
    expect((await anon.post(`/host/openwop-app/partner/${token}/register`, { dealTitle: 'X', companyName: 'Y' })).status).toBe(404);
  });

  it('deleting the dealer’s CRM company suspends the dealer (DEAL-DATA-2 / ADR 0283)', async () => {
    const { owner, orgId, dealerId } = await setup();
    const companyId = (await owner.get(`${B(orgId)}/dealers/${dealerId}`)).body.companyId;
    expect((await owner.get(`${B(orgId)}/dealers/${dealerId}`)).body.status).toBe('active');
    // delete the CRM company → the crmRecordLifecycle hook suspends the dealer
    expect((await owner.del(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies/${encodeURIComponent(companyId)}`)).status).toBe(204);
    expect((await owner.get(`${B(orgId)}/dealers/${dealerId}`)).body.status).toBe('suspended');
  });

  it('registration review is visible + decidable only to host:dealers:manage', async () => {
    const { owner, orgId, dealerId, tenantId } = await setup();
    const token = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token;
    await client(false).post(`/host/openwop-app/partner/${token}/register`, { dealTitle: 'D', companyName: 'C' });

    // The manager (host:dealers:manage) sees the queued dealer-registration review.
    const ownerReviews = await owner.get('/host/openwop-app/reviews?status=pending');
    const review = ownerReviews.body.items.find((r) => r.kind === 'dealer-registration');
    if (!review) throw new Error('the manager must see the queued dealer-registration review');

    // an editor member (workspace:write, no manage) IN THE SAME TENANT cannot see it
    // in the inbox NOR decide it (the reviews visibility narrows to the manage bar,
    // the SAME bar the demolished route enforced — reused here).
    const editor = client();
    const editorId = (await editor.post('/host/openwop-app/test/login', { email: `e-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorId, roles: ['editor'] });
    const editorReviews = await editor.get('/host/openwop-app/reviews?status=pending');
    // the inbox READ succeeds — so an empty match is the audience filter, not a failed read
    expect(editorReviews.status).toBe(200);
    expect(Array.isArray(editorReviews.body.items)).toBe(true);
    expect(editorReviews.body.items.some((r) => r.kind === 'dealer-registration')).toBe(false);
    // a direct decide attempt is refused: the review is outside their audience, so
    // the route answers not-found before the decision gate (double guard, see header)
    const attempt = await editor.post(`/host/openwop-app/reviews/${review.reviewId}/actions/approve`);
    expect(attempt.status).toBe(404);
    // …and nothing was decided
    expect((await owner.get(`${B(orgId)}/registrations`)).body.registrations[0]!.status).toBe('pending');
  });
});
