/**
 * Dealer Network — Phase 1 (dealer + outlet CRUD).
 * ROUTE-level harness. Covers: toggle-off 404; dealer CRUD referencing a real CRM
 * company (dangling ref rejected); outlet CRUD owned by a dealer; dealer delete
 * cascades outlets; RBAC (read vs write); tenant/org IDOR; geo validation.
 *
 * TST-CUD-1. The org-IDOR leg reads a dealer through a SECOND org in the SAME
 * tenant (the caller is admin of both), so `getDealer`'s org clause is the only
 * guard (red when `d.orgId !== orgId` is dropped). Also red when a viewer can
 * write, when a dangling companyId is accepted, when the delete stops cascading
 * outlets, or when the geo bound moves.
 *
 * DOUBLE GUARD (recorded, w69 r3): the cross-TENANT leg is refused by BOTH of
 * `getDealer`'s clauses, `d.tenantId !== tenantId` and `d.orgId !== orgId`, and
 * the tenant clause cannot be reached alone over HTTP. Org ids are globally
 * unique: the org store is keyed by `orgId` alone (`access-orgs`, keyed
 * `o.orgId`), and `authorizeOrgScope` admits a path org only inside the caller's
 * own tenant. So a caller from another tenant always names a DIFFERENT orgId, and
 * the org clause refuses first. Dropping only the tenant clause stays green (probe
 * w69g1-dc-idor-tenant-only-r2, vacuous by construction); dropping BOTH reds the
 * cross-tenant leg (w69g1-dc-idor-both-r3). The dealer store itself is NOT
 * tenant-scoped (`dealers.get(dealerId)` is a global point read), so there is no
 * third guard.
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

interface Res<T> { status: number; body: T }
interface Body {
  error?: string; message?: string;
  user?: { userId: string }; orgId?: string; companyId?: string;
  dealerId?: string; status?: string; lat?: number; removed?: number;
  outlets?: Array<{ outletId: string }>;
}
interface Client { get: (p: string) => Promise<Res<Body>>; post: (p: string, b?: unknown) => Promise<Res<Body>>; patch: (p: string, b?: unknown) => Promise<Res<Body>>; del: (p: string) => Promise<Res<Body>> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<Body>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}
let n = 0;
async function scenario(memberRole: string): Promise<{ owner: Client; member: Client; orgId: string; companyId: string }> {
  const tenantId = `org:dealer-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client();
  const memberId = (await member.post('/host/openwop-app/test/login', { email: `m-${Date.now()}-${n++}@acme.test`, tenantId })).body.user!.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId!;
  await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberId, roles: [memberRole] });
  const companyId = (await owner.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: 'Dealer Co' })).body.companyId!;
  return { owner, member, orgId, companyId };
}
const B = (orgId: string): string => `/host/openwop-app/dealers/orgs/${encodeURIComponent(orgId)}`;

describe('dealers — toggle gating', () => {
  it('404s when off, works when on', async () => {
    const def = getToggleDefault('dealers');
    if (!def) throw new Error('no dealers toggle default');
    const { owner, orgId } = await scenario('admin');
    await saveConfig({ ...def, status: 'off' }, 'test');
    try {
      const off = await owner.get(`${B(orgId)}/dealers`);
      expect(off.status).toBe(404);
      expect(off.body.error).toBe('not_found');
    } finally {
      await saveConfig({ ...def, status: 'on' }, 'test');
    }
    expect((await owner.get(`${B(orgId)}/dealers`)).status).toBe(200);
  });
});

describe('dealers — dealer + outlet CRUD, cascade, RBAC', () => {
  it('creates a dealer referencing a real company; rejects a dangling companyId', async () => {
    const { owner, orgId, companyId } = await scenario('admin');
    const dealer = await owner.post(`${B(orgId)}/dealers`, { name: 'North Dealer', companyId, tier: 'Gold' });
    expect(dealer.status, JSON.stringify(dealer.body)).toBe(201);
    expect(dealer.body.status).toBe('active');
    // dangling companyId → 404, naming the company (not a dealer/org 404)
    const dangling = await owner.post(`${B(orgId)}/dealers`, { name: 'X', companyId: 'company:nope' });
    expect(dangling.status).toBe(404);
    expect(dangling.body.message).toBe('The referenced CRM company does not exist in this org.');
    const missing = await owner.post(`${B(orgId)}/dealers`, { name: 'X' }); // no companyId
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/companyId/);
  });

  it('outlets are owned by a dealer; a dealer delete cascades its outlets; geo is validated', async () => {
    const { owner, orgId, companyId } = await scenario('admin');
    const dealerId = (await owner.post(`${B(orgId)}/dealers`, { name: 'D', companyId })).body.dealerId!;
    const o1 = await owner.post(`${B(orgId)}/dealers/${dealerId}/outlets`, { name: 'Store A', address: '1 Main St', lat: 40.7, lng: -74 });
    expect(o1.status, JSON.stringify(o1.body)).toBe(201);
    expect(o1.body.lat).toBe(40.7);
    await owner.post(`${B(orgId)}/dealers/${dealerId}/outlets`, { name: 'Store B' });
    expect((await owner.get(`${B(orgId)}/dealers/${dealerId}/outlets`)).body.outlets).toHaveLength(2);
    // bad geo rejected (and the bound is ±90 for lat: 90 itself is accepted)
    const badGeo = await owner.post(`${B(orgId)}/dealers/${dealerId}/outlets`, { name: 'Bad', lat: 200 });
    expect(badGeo.status).toBe(400);
    expect(badGeo.body.message).toMatch(/`lat` must be a number within ±90/);
    // outlet on a missing dealer → 404
    const noDealer = await owner.post(`${B(orgId)}/dealers/dealer:nope/outlets`, { name: 'X' });
    expect(noDealer.status).toBe(404);
    expect(noDealer.body.message).toBe('Dealer not found.');

    // delete dealer → cascades outlets (removed = 2 outlets + dealer = 3)
    const del = await owner.del(`${B(orgId)}/dealers/${dealerId}`);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(3);
    expect((await owner.get(`${B(orgId)}/outlets`)).body.outlets).toHaveLength(0);
  });

  it('enforces read vs write RBAC and org IDOR', async () => {
    const { owner, member, orgId, companyId } = await scenario('viewer'); // viewer: read only
    const dealerId = (await owner.post(`${B(orgId)}/dealers`, { name: 'D', companyId })).body.dealerId!;
    expect((await member.get(`${B(orgId)}/dealers`)).status).toBe(200); // viewer reads
    const denied = await member.post(`${B(orgId)}/dealers`, { name: 'X', companyId }); // viewer cannot write
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/workspace:write/);

    // org IDOR inside ONE tenant: the owner (admin of both orgs) asks for org A's
    // dealer through org B's path — only the dealer's own org clause refuses it.
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Sister' })).body.orgId!;
    expect((await owner.get(`${B(orgB)}/dealers`)).status).toBe(200); // positive control: B is readable
    const crossOrg = await owner.get(`${B(orgB)}/dealers/${encodeURIComponent(dealerId)}`);
    expect(crossOrg.status).toBe(404);
    expect(crossOrg.body.message).toBe('Dealer not found.');
    expect((await owner.get(`${B(orgId)}/dealers/${encodeURIComponent(dealerId)}`)).status).toBe(200); // owner control

    // tenant IDOR: a stranger tenant's admin cannot read it through their own org
    // (double guard: tenant + org clause — see the header)
    const other = await scenario('admin');
    const crossTenant = await other.owner.get(`${B(other.orgId)}/dealers/${encodeURIComponent(dealerId)}`);
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.message).toBe('Dealer not found.');
  });
});
