/**
 * CDP-H — scoped API-key AUTH wiring (ADR 0270). A live owk_ key authenticates as
 * bearer, scoped to the key's OWN tenant; an invalid or revoked key authenticates
 * nobody (fail-closed). Security-critical — asserted through the HTTP boundary via
 * tenant-scoped CRM reads.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'developer-keys']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function cookieClient() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown) => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
// A cookieless call carrying ONLY a Bearer token.
async function bearerGet(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => undefined) as any };
}
let n = 0;
const hasContact = (body: any, id: string): boolean => Array.isArray(body?.contacts) && body.contacts.some((c: any) => c.contactId === id);

describe('CDP-H API-key auth wiring', () => {
  it('a live owk_ key authenticates as its tenant; invalid + revoked keys do not', async () => {
    const tenantId = `org:key-${Date.now()}-${n++}`;
    const c = cookieClient();
    expect((await c.post('/v1/host/openwop-app/test/login', { email: `k-${Date.now()}@a.test`, tenantId })).status).toBe(201);
    const contact = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'KeyTest', email: 'k@x.test' })).body;
    const contactId = contact.contactId;

    const issued = await c.post('/v1/host/openwop-app/developer-keys', { name: 'ci', scopes: ['manifest:read'] });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const token = issued.body.token as string;
    const keyId = issued.body.key.keyId as string;

    // VALID key (cookieless Bearer) → sees the tenant's contact
    const ok = await bearerGet('/v1/host/openwop-app/crm/contacts', token);
    expect(ok.status).toBe(200);
    expect(hasContact(ok.body, contactId)).toBe(true);

    // INVALID key → NOT authenticated as the tenant (fail-closed)
    const bad = await bearerGet('/v1/host/openwop-app/crm/contacts', 'owk_totally-bogus');
    expect(hasContact(bad.body, contactId)).toBe(false);

    // REVOKED key → no longer authenticates
    expect((await c.del(`/v1/host/openwop-app/developer-keys/${keyId}`)).status).toBe(204);
    const revoked = await bearerGet('/v1/host/openwop-app/crm/contacts', token);
    expect(hasContact(revoked.body, contactId)).toBe(false);
  });
});
