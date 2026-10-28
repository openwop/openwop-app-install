/**
 * Sales Maps — ADR 0282 Phase 2 (geocoding cache, `features/sales-maps/entities/geocode.ts`).
 * Manual lat/lng seeds + caches; a repeat lookup hits the cache; a genuine miss (no
 * provider) fails LOUD (capability_not_provided, not a fabricated coordinate);
 * write-scoped; tenant/org isolated.
 *
 * Isolation is a DOUBLE guard: the cache key folds `${tenantId}:${orgId}`, and a hit is
 * re-checked against the row's own tenantId/orgId. With distinct keys a foreign row is
 * never even read, so the row re-check can only fire once the key collides — it is
 * unwitnessable alone (a recorded ceiling). The legs that CAN fail on the key are the
 * OVERWRITE legs: a second org (same tenant) / a second tenant seeds the SAME address,
 * and the first owner must still read its own point. Round 1's org case used two
 * TENANTS and only a read, so `8fw2g3-geo-orgkey` was vacuous. The tenant half of the
 * key is witnessed only together with the org half (`-geo-tenantkey`): minted orgIds
 * never collide across tenants, so the tenant fold alone (ADR comment "DEAL-DATA,
 * defense-in-depth") is a second recorded ceiling.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): whitespace normalization removed
 * (`8fw2g3-geo-normalize`), the lat bound widened (`-geo-lat`), the write scope relaxed
 * (`-geo-scope`), the orgId dropped from the key (`-geo-orgkey-r2`), and the whole
 * scope dropped from the key (`-geo-tenantkey-r2`).
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

interface Res { status: number; body: unknown }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
/** The geocode route's body (`routes.ts` projects `GeocodeResult` to these four fields). */
interface GeocodeBody { address: string; lat: number; lng: number; source: 'manual' | 'provider' }
interface ErrorBody { error: string; message?: string }
const geo = (r: Res): GeocodeBody => r.body as GeocodeBody;
const err = (r: Res): ErrorBody => r.body as ErrorBody;
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
async function newOrg(owner: Client, name: string): Promise<string> {
  const r = await owner.post('/host/openwop-app/orgs', { name });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { orgId: string }).orgId;
}
async function scenario(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:maps-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client();
  const memberId = ((await member.post('/host/openwop-app/test/login', { email: `m-${Date.now()}-${n++}@acme.test`, tenantId })).body as { user: { userId: string } }).user.userId;
  const orgId = await newOrg(owner, 'Acme');
  await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberId, roles: [role] });
  return { owner, member, orgId };
}
const G = (orgId: string): string => `/host/openwop-app/sales-maps/orgs/${encodeURIComponent(orgId)}/geocode`;

describe('sales-maps — geocode cache', () => {
  it('seeds + caches a manual coordinate; a genuine miss fails loud; validates + write-scopes', async () => {
    const { owner, member, orgId } = await scenario('viewer');

    // manual lat/lng → cached
    const seeded = await owner.post(G(orgId), { address: '1 Main St, NYC', lat: 40.71, lng: -74.01 });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    expect(geo(seeded)).toMatchObject({ source: 'manual', lat: 40.71, lng: -74.01 });

    // repeat WITHOUT coords → cache hit (case/space-insensitive key)
    const hit = await owner.post(G(orgId), { address: '1 MAIN ST,  NYC' });
    expect(hit.status).toBe(200);
    expect(geo(hit)).toMatchObject({ source: 'manual', lat: 40.71, lng: -74.01 });

    // genuine miss (no provider configured) → 503 capability_not_provided, NOT a made-up point
    const miss = await owner.post(G(orgId), { address: 'somewhere uncached' });
    expect(miss.status).toBe(503);
    expect(err(miss).error).toBe('capability_not_provided');

    // validation + RBAC — each refusal is the one named, not a neighbour's.
    const badLat = await owner.post(G(orgId), { address: 'x', lat: 200, lng: 0 });
    expect(badLat.status).toBe(400);
    expect(err(badLat)).toMatchObject({ error: 'validation_error', message: '`lat` must be a number within ±90.' });
    const noAddress = await owner.post(G(orgId), {});
    expect(noAddress.status).toBe(400);
    expect(err(noAddress)).toMatchObject({ error: 'validation_error', message: '`address` is required.' });
    const viewer = await member.post(G(orgId), { address: 'y', lat: 1, lng: 1 }); // viewer: no workspace:write
    expect(viewer.status).toBe(403);
    expect(err(viewer).error).toBe('forbidden_scope');
  });

  it('isolates the geocode cache across orgs', async () => {
    // ONE tenant, two orgs (a cross-tenant pair is refused by the tenant before any org check).
    const { owner, orgId: orgA } = await scenario('admin');
    const orgB = await newOrg(owner, 'Beta');
    expect((await owner.post(G(orgA), { address: 'Shared Address', lat: 1, lng: 1 })).status).toBe(200);
    // Org B seeds the SAME address with a different point: it must not overwrite org A's row.
    expect((await owner.post(G(orgB), { address: 'Shared Address', lat: 2, lng: 2 })).status).toBe(200);
    const aRead = await owner.post(G(orgA), { address: 'Shared Address' });
    expect(aRead.status, JSON.stringify(aRead.body)).toBe(200);
    expect(geo(aRead)).toEqual({ address: 'Shared Address', lat: 1, lng: 1, source: 'manual' });
    const bRead = await owner.post(G(orgB), { address: 'Shared Address' });
    expect(geo(bRead)).toEqual({ address: 'Shared Address', lat: 2, lng: 2, source: 'manual' });
    // An address only org A cached is a miss for org B, not org A's point.
    expect((await owner.post(G(orgA), { address: 'Only In A', lat: 3, lng: 3 })).status).toBe(200);
    const bMiss = await owner.post(G(orgB), { address: 'Only In A' });
    expect(bMiss.status).toBe(503);
    expect(err(bMiss).error).toBe('capability_not_provided');
  });

  it('isolates the geocode cache across tenants', async () => {
    const a = await scenario('admin');
    const b = await scenario('admin');
    expect((await a.owner.post(G(a.orgId), { address: 'Tenant Shared', lat: 4, lng: 4 })).status).toBe(200);
    expect((await b.owner.post(G(b.orgId), { address: 'Tenant Shared', lat: 5, lng: 5 })).status).toBe(200);
    expect(geo(await a.owner.post(G(a.orgId), { address: 'Tenant Shared' }))).toMatchObject({ lat: 4, lng: 4 });
    expect((await a.owner.post(G(a.orgId), { address: 'Only Tenant A', lat: 6, lng: 6 })).status).toBe(200);
    const bMiss = await b.owner.post(G(b.orgId), { address: 'Only Tenant A' });
    expect(bMiss.status).toBe(503);
    expect(err(bMiss).error).toBe('capability_not_provided');
  });
});
