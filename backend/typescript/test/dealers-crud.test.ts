/**
 * Dealer Network — Phase 1 (dealer + outlet CRUD).
 * ROUTE-level harness. Covers: toggle-off 404; dealer CRUD referencing a real CRM
 * company (dangling ref rejected); outlet CRUD owned by a dealer; dealer delete
 * cascades outlets; RBAC (read vs write); tenant/org IDOR; geo validation.
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
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}
let n = 0;
async function scenario(memberRole: string): Promise<{ owner: Client; member: Client; orgId: string; companyId: string }> {
  const tenantId = `org:dealer-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client();
  const memberId = (await member.post('/v1/host/openwop-app/test/login', { email: `m-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberId, roles: [memberRole] });
  const companyId = (await owner.post(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: 'Dealer Co' })).body.companyId;
  return { owner, member, orgId, companyId };
}
const B = (orgId: string): string => `/v1/host/openwop-app/dealers/orgs/${encodeURIComponent(orgId)}`;

describe('dealers — toggle gating', () => {
  it('404s when off, works when on', async () => {
    const def = getToggleDefault('dealers');
    if (def) await saveConfig({ ...def, status: 'off' }, 'test');
    const { owner, orgId } = await scenario('admin');
    expect((await owner.get(`${B(orgId)}/dealers`)).status).toBe(404);
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
    expect((await owner.get(`${B(orgId)}/dealers`)).status).toBe(200);
  });
});

describe('dealers — dealer + outlet CRUD, cascade, RBAC', () => {
  it('creates a dealer referencing a real company; rejects a dangling companyId', async () => {
    const { owner, orgId, companyId } = await scenario('admin');
    const dealer = await owner.post(`${B(orgId)}/dealers`, { name: 'North Dealer', companyId, tier: 'Gold' });
    expect(dealer.status, JSON.stringify(dealer.body)).toBe(201);
    expect(dealer.body.status).toBe('active');
    // dangling companyId → 404
    expect((await owner.post(`${B(orgId)}/dealers`, { name: 'X', companyId: 'company:nope' })).status).toBe(404);
    expect((await owner.post(`${B(orgId)}/dealers`, { name: 'X' })).status).toBe(400); // no companyId
  });

  it('outlets are owned by a dealer; a dealer delete cascades its outlets; geo is validated', async () => {
    const { owner, orgId, companyId } = await scenario('admin');
    const dealerId = (await owner.post(`${B(orgId)}/dealers`, { name: 'D', companyId })).body.dealerId;
    const o1 = await owner.post(`${B(orgId)}/dealers/${dealerId}/outlets`, { name: 'Store A', address: '1 Main St', lat: 40.7, lng: -74 });
    expect(o1.status, JSON.stringify(o1.body)).toBe(201);
    expect(o1.body.lat).toBe(40.7);
    await owner.post(`${B(orgId)}/dealers/${dealerId}/outlets`, { name: 'Store B' });
    expect((await owner.get(`${B(orgId)}/dealers/${dealerId}/outlets`)).body.outlets).toHaveLength(2);
    // bad geo rejected
    expect((await owner.post(`${B(orgId)}/dealers/${dealerId}/outlets`, { name: 'Bad', lat: 200 })).status).toBe(400);
    // outlet on a missing dealer → 404
    expect((await owner.post(`${B(orgId)}/dealers/dealer:nope/outlets`, { name: 'X' })).status).toBe(404);

    // delete dealer → cascades outlets (removed = 2 outlets + dealer = 3)
    const del = await owner.del(`${B(orgId)}/dealers/${dealerId}`);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(3);
    expect((await owner.get(`${B(orgId)}/outlets`)).body.outlets).toHaveLength(0);
  });

  it('enforces read vs write RBAC and org IDOR', async () => {
    const { owner, member, orgId, companyId } = await scenario('viewer'); // viewer: read only
    const dealerId = (await owner.post(`${B(orgId)}/dealers`, { name: 'D', companyId })).body.dealerId;
    expect((await member.get(`${B(orgId)}/dealers`)).status).toBe(200); // viewer reads
    expect((await member.post(`${B(orgId)}/dealers`, { name: 'X', companyId })).status).toBe(403); // viewer cannot write

    const other = await scenario('admin');
    expect((await other.owner.get(`${B(other.orgId)}/dealers/${dealerId}`)).status).toBe(404); // cross-org IDOR
  });
});
