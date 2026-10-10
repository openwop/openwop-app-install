/**
 * ADR 0864 — `GET /host/openwop-app/access/summary` through the real HTTP
 * boundary: each section counts exactly what its own list route shows the same
 * caller (D2), a section the caller may not read is OMITTED rather than zero, the
 * reconnect banner's subject follows the Connections panel's predicate and axis
 * (D4), and another tenant's rows never count.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import type { Connection } from '../src/features/connections/connectionsService.js';

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
  const call = async (m: string, p: string, b?: unknown) => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p), hasCookie: () => cookie !== '' };
}

async function signedIn() {
  const c = client();
  const tenantId = `org:ahs-${Date.now()}-${n++}`;
  const r = await c.post('/host/openwop-app/test/login', { email: `ahs-${Date.now()}-${n++}@a.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, tenantId };
}

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
    const keyId = gone.body?.key?.keyId;
    expect(typeof keyId, JSON.stringify(gone.body)).toBe('string');
    expect((await c.del(`/host/openwop-app/developer-keys/${keyId}`)).status).toBeLessThan(300);

    const listed = await c.get('/host/openwop-app/developer-keys');
    expect(listed.status).toBe(200);
    const live = (listed.body.keys as { name: string; revokedAt?: string }[]).filter((k) => !k.revokedAt);

    const s = await c.get(SUMMARY);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.apiKeys.count).toBe(live.length);
    expect(s.body.mcpClients.count).toBe(live.filter((k) => k.name.startsWith('MCP: ')).length);
    expect(s.body.mcpClients.count).toBe(1);
    expect(s.body.apiKeys.count).toBe(2);
    expect(s.body.apiKeys.expired).toBe(0);
  });

  it('organizations match /orgs; firewall reports the default policy; keys are present', async () => {
    const { c } = await signedIn();
    const orgs = await c.get('/host/openwop-app/orgs');
    const s = await c.get(SUMMARY);
    expect(s.status).toBe(200);
    expect(s.body.orgs.count).toBe(orgs.body.orgs.length);
    expect(typeof s.body.orgs.members).toBe('number');
    expect(s.body.firewall).toEqual({ isDefault: true, rules: 0 });
    expect(s.body.keys).toEqual({ count: 0 });
  });

  it('connections: counts follow /connections, the reconnect subject follows the panel predicate and axis, and another tenant never counts', async () => {
    const { c, tenantId } = await signedIn();
    const other = `org:ahs-other-${Date.now()}`;
    await connections.put(row(tenantId, `ahs-broken-${n}`, { status: 'needs-reconsent', displayName: 'Google Drive' }));
    await connections.put(row(tenantId, `ahs-ok-${n}`, { provider: 'slack', displayName: 'Slack' }));
    // not oauth2 ⇒ never "needs reconnecting", whatever its status says
    await connections.put(row(tenantId, `ahs-key-${n}`, { kind: 'api_key', status: 'expired', provider: 'stripe', displayName: 'Stripe' }));
    await connections.put(row(other, `ahs-foreign-${n}`, { status: 'needs-reconsent', displayName: 'Foreign' }));

    const listed = await c.get('/host/openwop-app/connections');
    expect(listed.status).toBe(200);
    const s = await c.get(SUMMARY);
    expect(s.status).toBe(200);
    const ws = s.body.connections.workspace;
    expect(ws.count).toBe((listed.body.connections as { userId?: string }[]).filter((x) => !x.userId).length);
    expect(ws.count).toBe(3);
    expect(ws.needsReconnect).toBe(1);
    expect(ws.reconnect).toEqual([{ connectionId: `ahs-broken-${n}`, displayName: 'Google Drive', provider: 'google' }]);
    expect(s.body.connections.personal).toEqual({ count: 0, needsReconnect: 0, reconnect: [] });
    expect(JSON.stringify(s.body)).not.toContain('Foreign');
  });

  it('an anonymous session gets no API-key sections — omitted, not zero', async () => {
    const anon = client();
    await anon.get('/host/openwop-app/roster');
    expect(anon.hasCookie(), 'the anonymous session must exist, or this leg proves nothing').toBe(true);
    // control: the list route itself refuses this caller
    expect((await anon.get('/host/openwop-app/developer-keys')).status).toBe(401);
    const s = await anon.get(SUMMARY);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).not.toHaveProperty('apiKeys');
    expect(s.body).not.toHaveProperty('mcpClients');
  });

  it('endpoints: omitted while the operator gate is off; once on, the sum of GET over every org the panel offers (ADR 0866)', async () => {
    const { c } = await signedIn();
    const orgA = (await c.post('/host/openwop-app/orgs', { name: 'A' })).body.orgId as string;
    const orgB = (await c.post('/host/openwop-app/orgs', { name: 'B' })).body.orgId as string;
    delete process.env.OPENWOP_COMPAT_PROVIDER_ENABLED;
    expect((await c.get(SUMMARY)).body).not.toHaveProperty('endpoints');

    process.env.OPENWOP_COMPAT_PROVIDER_ENABLED = 'true';
    try {
      for (const [orgId, label] of [[orgA, 'a1'], [orgA, 'a2'], [orgB, 'b1']]) {
        expect((await c.post('/host/openwop-app/compat-endpoints', { orgId, label, baseUrl: `https://${label}.example.com/v1` })).status).toBe(201);
      }
      const orgs = (await c.get('/host/openwop-app/orgs')).body.orgs as { orgId: string }[];
      let viaGet = 0;
      for (const o of orgs) viaGet += ((await c.get(`/host/openwop-app/compat-endpoints?orgId=${o.orgId}`)).body.endpoints as unknown[]).length;
      const s = await c.get(SUMMARY);
      expect(s.body.endpoints).toEqual({ count: viaGet });
      expect(viaGet).toBe(3);
      // another tenant's endpoints never count
      const other = await signedIn();
      expect((await other.c.get(SUMMARY)).body.endpoints).toEqual({ count: 0 });
    } finally {
      delete process.env.OPENWOP_COMPAT_PROVIDER_ENABLED;
    }
  });

  it('connections read the same once the tenant index is verified, and fall back when it is not (ADR 0866)', async () => {
    const { c, tenantId } = await signedIn();
    await connections.put(row(tenantId, `ahs-v-${n}`, { status: 'expired', displayName: 'Drive' }));
    const before = (await c.get(SUMMARY)).body.connections;
    const indexedStore = new DurableCollection<Connection>('connections:connection', (x) => x.connectionId, undefined, (x) => x.tenantId);
    await indexedStore.reconcileTenantIndex({ windowMs: 0 });
    expect(await indexedStore.tenantIndexVerified()).toBe(true);
    expect((await c.get(SUMMARY)).body.connections).toEqual(before);
    // A pre-index writer lands a row after verification: the next pass repairs it and
    // un-verifies (the fallback itself is pinned in hostext-tenant-index-adoption.test.ts).
    await connections.put(row(tenantId, `ahs-late-${n}`, { provider: 'slack', displayName: 'Late' }));
    expect(await indexedStore.reconcileTenantIndex({ windowMs: 0 })).toMatchObject({ reset: true });
    const after = (await c.get(SUMMARY)).body.connections.workspace;
    expect(after.count).toBe(before.workspace.count + 1);
  });

  it('carries counts, not credentials', async () => {
    const { c } = await signedIn();
    const s = await c.get(SUMMARY);
    expect(JSON.stringify(s.body)).not.toMatch(/owk_|credentialRef|tokenHash/);
  });
});
