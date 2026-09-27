/**
 * Sales Maps — Phase 2 (geocoding cache). Manual lat/lng seeds + caches; a repeat
 * lookup hits the cache; a genuine miss (no provider) fails LOUD (capability_not_
 * provided, not a fabricated coordinate); write-scoped; tenant/org isolated.
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
  for (const id of ['users', 'sales-maps']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}
let n = 0;
async function scenario(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:maps-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client();
  const memberId = (await member.post('/v1/host/openwop-app/test/login', { email: `m-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberId, roles: [role] });
  return { owner, member, orgId };
}
const G = (orgId: string): string => `/v1/host/openwop-app/sales-maps/orgs/${encodeURIComponent(orgId)}/geocode`;

describe('sales-maps — geocode cache', () => {
  it('seeds + caches a manual coordinate; a genuine miss fails loud; validates + write-scopes', async () => {
    const { owner, member, orgId } = await scenario('viewer');

    // manual lat/lng → cached
    const seeded = await owner.post(G(orgId), { address: '1 Main St, NYC', lat: 40.71, lng: -74.01 });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    expect(seeded.body.source).toBe('manual');
    expect(seeded.body.lat).toBe(40.71);

    // repeat WITHOUT coords → cache hit (case/space-insensitive key)
    const hit = await owner.post(G(orgId), { address: '1 MAIN ST,  NYC' });
    expect(hit.status).toBe(200);
    expect(hit.body.lat).toBe(40.71);
    expect(hit.body.source).toBe('manual');

    // genuine miss (no provider configured) → 503 capability_not_provided, NOT a made-up point
    const miss = await owner.post(G(orgId), { address: 'somewhere uncached' });
    expect(miss.status).toBe(503);
    expect(miss.body.error).toBe('capability_not_provided');

    // validation + RBAC
    expect((await owner.post(G(orgId), { address: 'x', lat: 200, lng: 0 })).status).toBe(400); // bad lat
    expect((await owner.post(G(orgId), {})).status).toBe(400); // no address
    expect((await member.post(G(orgId), { address: 'y', lat: 1, lng: 1 })).status).toBe(403); // viewer: no workspace:write
  });

  it('isolates the geocode cache across orgs', async () => {
    const a = await scenario('admin');
    const b = await scenario('admin');
    await a.owner.post(G(a.orgId), { address: 'Shared Address', lat: 1, lng: 1 });
    // org B has no cache for the same address string → miss (503), not org A's point
    expect((await b.owner.post(G(b.orgId), { address: 'Shared Address' })).status).toBe(503);
  });
});
