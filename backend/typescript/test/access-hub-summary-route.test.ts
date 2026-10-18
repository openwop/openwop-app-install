/**
 * ADR 0864 — `GET /host/openwop-app/access/summary` through the real HTTP
 * boundary: each section counts exactly what its own list route shows the same
 * caller (D2), a section the caller may not read is OMITTED rather than zero, the
 * reconnect banner's subject follows the Connections panel's predicate and axis
 * (D4), and another tenant's rows never count.
 *
 * Every count is pinned to an ABSOLUTE number with a positive control, never only to
 * its list route (both sides read the same shared reader, so `summary === list` alone
 * is blind to a break inside that reader). Probes (`w27g2-ahs-*`): revoked / MCP-prefix
 * / expired key counting, the reconnect predicate's kind + `expired` legs, the
 * personal axis and its OWNER filter (a same-tenant stranger's personal row), another
 * tenant's rows, the omitted anonymous sections, the endpoints gate + per-org scope
 * skip (a SAME-tenant co-member who can read only one of two orgs), the org + member
 * counts, the firewall default, and no credential material in the body.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import type { Connection } from '../src/features/connections/connectionsService.js';
import type { AccessSummary } from '../src/features/access-hub/summary.js';

const SUMMARY = '/host/openwop-app/access/summary';
let BASE: string; let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  // `<T>` names the shape the caller expects; the body is untyped JSON on the wire.
  const call = async <T>(m: string, p: string, b?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    del: (p: string) => call<unknown>('DELETE', p),
    summary: () => call<AccessSummary>('GET', SUMMARY),
    hasCookie: () => cookie !== '',
  };
}

interface ListedKey { keyId: string; name: string; revokedAt?: string }
interface IssuedKey { token: string; key: ListedKey & { hint?: string } }

async function login(tenantId: string) {
  const c = client();
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `ahs-${Date.now()}-${n++}@a.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, tenantId, userId: r.body.user.userId };
}
const signedIn = () => login(`org:ahs-${Date.now()}-${n++}`);

// The connections store's own keyspace — seeding rows directly avoids needing a
// tenant KMS for the OAuth token material, which the summary never reads.
const connections = new DurableCollection<Connection>('connections:connection', (c) => c.connectionId);
function row(tenantId: string, id: string, over: Partial<Connection>): Connection {
  const at = new Date().toISOString();
  return { connectionId: id, tenantId, provider: 'google', kind: 'oauth2', displayName: id, scopes: [], status: 'active', connectedAt: at, updatedAt: at, ...over };
}

describe('access hub summary (ADR 0864)', () => {
  it('API keys and AI clients count exactly what /developer-keys lists, revoked keys excluded', async () => {
    const { c } = await signedIn();
    expect((await c.post('/host/openwop-app/developer-keys', { name: 'ci', scopes: ['runs:read'] })).status).toBe(201);
    expect((await c.post('/host/openwop-app/developer-keys', { name: 'MCP: Claude', scopes: ['workspace:read'] })).status).toBe(201);
    const gone = await c.post('/host/openwop-app/developer-keys', { name: 'old', scopes: ['runs:read'] });
    expect(gone.status).toBe(201);
    const keyId = (gone.body as IssuedKey | undefined)?.key?.keyId;
    expect(typeof keyId, JSON.stringify(gone.body)).toBe('string');
    expect((await c.del(`/host/openwop-app/developer-keys/${keyId}`)).status).toBeLessThan(300);

    const listed = await c.get<{ keys: ListedKey[] }>('/host/openwop-app/developer-keys');
    expect(listed.status).toBe(200);
    const live = listed.body.keys.filter((k) => !k.revokedAt);

    const s = await c.summary();
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.apiKeys?.count).toBe(live.length);
    expect(s.body.mcpClients?.count).toBe(live.filter((k) => k.name.startsWith('MCP: ')).length);
    expect(s.body.mcpClients?.count).toBe(1);
    expect(s.body.apiKeys?.count).toBe(2);
    expect(s.body.apiKeys?.expired).toBe(0);
  });

  it('organizations match /orgs; firewall reports the default policy; keys are present', async () => {
    const { c, tenantId } = await signedIn();
    // Grow both counts past their login baseline (the founding workspace root + its
    // owner), so neither a constant nor the baseline can satisfy the assertions.
    expect((await c.post('/host/openwop-app/orgs', { name: 'O2' })).status).toBe(201);
    expect((await c.post(`/host/openwop-app/orgs/${tenantId}/members`, { displayName: 'Second', subject: `user:ahs-second-${n}`, roles: ['viewer'] })).status).toBe(201);
    expect((await c.post('/host/openwop-app/byok/secrets', { credentialRef: `ahs-model-${n}`, value: 'sk-ahs-model-key' })).status).toBe(201);
    const orgs = await c.get<{ orgs: { orgId: string }[] }>('/host/openwop-app/orgs');
    const members = await c.get<{ members: unknown[] }>(`/host/openwop-app/orgs/${tenantId}/members`);
    const refs = await c.get<{ credentialRefs: string[] }>('/host/openwop-app/byok/secrets');
    const s = await c.summary();
    expect(s.status).toBe(200);
    expect(s.body.orgs).toEqual({ count: orgs.body.orgs.length, members: members.body.members.length });
    expect(s.body.orgs).toEqual({ count: 2, members: 2 });
    expect(s.body.firewall).toEqual({ isDefault: true, rules: 0 });
    expect(s.body.keys).toEqual({ count: refs.body.credentialRefs.length });
    expect(s.body.keys).toEqual({ count: 1 });
  });

  it('connections: counts follow /connections, the reconnect subject follows the panel predicate and axis, and another tenant never counts', async () => {
    const { c, tenantId, userId } = await signedIn();
    const other = `org:ahs-other-${Date.now()}`;
    await connections.put(row(tenantId, `ahs-broken-${n}`, { status: 'needs-reconsent', displayName: 'Google Drive' }));
    await connections.put(row(tenantId, `ahs-ok-${n}`, { provider: 'slack', displayName: 'Slack' }));
    // not oauth2 ⇒ never "needs reconnecting", whatever its status says
    await connections.put(row(tenantId, `ahs-key-${n}`, { kind: 'api_key', status: 'expired', provider: 'stripe', displayName: 'Stripe' }));
    await connections.put(row(other, `ahs-foreign-${n}`, { status: 'needs-reconsent', displayName: 'Foreign' }));
    // the second leg of the predicate: an EXPIRED oauth2 row also needs reconnecting
    await connections.put(row(tenantId, `ahs-expired-${n}`, { provider: 'hubspot', status: 'expired', displayName: 'HubSpot' }));
    // the personal axis: the caller's own row counts; a SAME-tenant stranger's never does
    await connections.put(row(tenantId, `ahs-mine-${n}`, { userId, provider: 'notion', status: 'expired', displayName: 'My Notion' }));
    await connections.put(row(tenantId, `ahs-theirs-${n}`, { userId: `user:ahs-stranger-${n}`, provider: 'dropbox', displayName: 'Stranger Dropbox' }));

    const listed = await c.get<{ connections: { userId?: string }[] }>('/host/openwop-app/connections');
    expect(listed.status).toBe(200);
    const s = await c.summary();
    expect(s.status).toBe(200);
    const ws = s.body.connections!.workspace;
    expect(ws.count).toBe(listed.body.connections.filter((x) => !x.userId).length);
    expect(ws.count).toBe(4);
    expect(ws.needsReconnect).toBe(2);
    // provider order (the shared reader sorts by provider): google < hubspot
    expect(ws.reconnect).toEqual([
      { connectionId: `ahs-broken-${n}`, displayName: 'Google Drive', provider: 'google' },
      { connectionId: `ahs-expired-${n}`, displayName: 'HubSpot', provider: 'hubspot' },
    ]);
    expect(s.body.connections!.personal).toEqual({
      count: 1, needsReconnect: 1, reconnect: [{ connectionId: `ahs-mine-${n}`, displayName: 'My Notion', provider: 'notion' }],
    });
    expect(JSON.stringify(s.body)).not.toContain('Foreign');
    expect(JSON.stringify(s.body)).not.toContain('Stranger');
  });

  it('an anonymous session gets no API-key sections — omitted, not zero', async () => {
    const anon = client();
    await anon.get('/host/openwop-app/roster');
    expect(anon.hasCookie(), 'the anonymous session must exist, or this leg proves nothing').toBe(true);
    // control: the list route itself refuses this caller
    expect((await anon.get('/host/openwop-app/developer-keys')).status).toBe(401);
    const s = await anon.summary();
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).not.toHaveProperty('apiKeys');
    expect(s.body).not.toHaveProperty('mcpClients');
  });

  it('endpoints: omitted while the operator gate is off; once on, the sum of GET over every org the panel offers (ADR 0866)', async () => {
    const { c, tenantId } = await signedIn();
    const orgA = (await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'A' })).body.orgId;
    const orgB = (await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'B' })).body.orgId;
    // A SAME-tenant co-member (the seam mints a session only when the workspace exists,
    // so no member row) given `viewer` in orgA ONLY: authenticated, in the tenant, able to
    // list every org, and refused `workspace:read` in orgB and the workspace root.
    const peer = await login(tenantId);
    expect((await c.post(`/host/openwop-app/orgs/${orgA}/members`, { displayName: 'Peer', subject: peer.userId, roles: ['viewer'] })).status).toBe(201);
    delete process.env.OPENWOP_COMPAT_PROVIDER_ENABLED;
    const off = await c.summary();
    expect(off.status).toBe(200);
    expect(off.body.orgs, 'control: the summary itself answered').toBeDefined();
    expect(off.body).not.toHaveProperty('endpoints');

    process.env.OPENWOP_COMPAT_PROVIDER_ENABLED = 'true';
    try {
      for (const [orgId, label] of [[orgA, 'a1'], [orgA, 'a2'], [orgB, 'b1']]) {
        expect((await c.post('/host/openwop-app/compat-endpoints', { orgId, label, baseUrl: `https://${label}.example.com/v1` })).status).toBe(201);
      }
      const orgs = (await c.get<{ orgs: { orgId: string }[] }>('/host/openwop-app/orgs')).body.orgs;
      let viaGet = 0;
      for (const o of orgs) viaGet += (await c.get<{ endpoints: unknown[] }>(`/host/openwop-app/compat-endpoints?orgId=${o.orgId}`)).body.endpoints.length;
      const s = await c.summary();
      expect(s.body.endpoints).toEqual({ count: viaGet });
      expect(viaGet).toBe(3);
      // the per-org scope skip: the peer's own GET reads orgA and is refused orgB …
      expect((await peer.c.get<{ endpoints: unknown[] }>(`/host/openwop-app/compat-endpoints?orgId=${orgA}`)).body.endpoints).toHaveLength(2);
      expect((await peer.c.get(`/host/openwop-app/compat-endpoints?orgId=${orgB}`)).status).toBe(403);
      // … and the summary counts exactly that: orgA's two, never orgB's one
      expect((await peer.c.summary()).body.endpoints).toEqual({ count: 2 });
      // another tenant's endpoints never count
      const other = await signedIn();
      expect((await other.c.summary()).body.endpoints).toEqual({ count: 0 });
    } finally {
      delete process.env.OPENWOP_COMPAT_PROVIDER_ENABLED;
    }
  });

  it('connections read the same once the tenant index is verified, and fall back when it is not (ADR 0866)', async () => {
    const { c, tenantId } = await signedIn();
    await connections.put(row(tenantId, `ahs-v-${n}`, { status: 'expired', displayName: 'Drive' }));
    const before = (await c.summary()).body.connections!;
    // the seeded EXPIRED oauth2 row needs reconnecting (the predicate's second leg)
    expect(before.workspace).toEqual({ count: 1, needsReconnect: 1, reconnect: [{ connectionId: `ahs-v-${n}`, displayName: 'Drive', provider: 'google' }] });
    const indexedStore = new DurableCollection<Connection>('connections:connection', (x) => x.connectionId, undefined, (x) => x.tenantId);
    await indexedStore.reconcileTenantIndex({ windowMs: 0 });
    expect(await indexedStore.tenantIndexVerified()).toBe(true);
    expect((await c.summary()).body.connections).toEqual(before);
    // A pre-index writer lands a row after verification: the next pass repairs it and
    // un-verifies (the fallback itself is pinned in hostext-tenant-index-adoption.test.ts).
    await connections.put(row(tenantId, `ahs-late-${n}`, { provider: 'slack', displayName: 'Late' }));
    expect(await indexedStore.reconcileTenantIndex({ windowMs: 0 })).toMatchObject({ reset: true });
    const after = (await c.summary()).body.connections!.workspace;
    expect(after.count).toBe(before.workspace.count + 1);
  });

  it('carries counts, not credentials', async () => {
    const { c } = await signedIn();
    // Seed every credential the sections count, so there is something to leak FROM.
    const issued = await c.post<IssuedKey>('/host/openwop-app/developer-keys', { name: 'leak-check', scopes: ['runs:read'] });
    expect(issued.status).toBe(201);
    expect(issued.body.token).toMatch(/^owk_/);
    const ref = `ahs-secret-ref-${n}`;
    expect((await c.post('/host/openwop-app/byok/secrets', { credentialRef: ref, value: 'sk-ahs-plaintext-value' })).status).toBe(201);
    const s = await c.summary();
    // positive control: both credentials are COUNTED …
    expect(s.body.apiKeys?.count).toBe(1);
    expect(s.body.keys).toEqual({ count: 1 });
    // … and none of their material, names or hashes is carried
    const body = JSON.stringify(s.body);
    for (const leaked of [issued.body.token, issued.body.key.keyId, 'leak-check', ref, 'sk-ahs-plaintext-value']) {
      expect(body).not.toContain(leaked);
    }
    expect(body).not.toMatch(/owk_|credentialRef|tokenHash/);
  });
});
