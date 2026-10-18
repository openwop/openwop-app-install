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
  for (const id of ['users', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The fields these cases read off any response (CRM list, key issue, error envelope). */
interface Body {
  contacts?: { contactId: string }[];
  contactId?: string;
  token?: string;
  key?: { keyId: string };
  error?: string;
  message?: string;
  details?: { code?: string };
}
interface Res { status: number; body: Body }
function cookieClient() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
// A cookieless call carrying ONLY a Bearer token.
async function bearerGet(path: string, token: string): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
}
let n = 0;
const hasContact = (body: Body, id: string): boolean => Array.isArray(body.contacts) && body.contacts.some((c) => c.contactId === id);

describe('CDP-H API-key auth wiring', () => {
  it('a live owk_ key authenticates as its tenant; invalid + revoked keys do not', async () => {
    const tenantId = `org:key-${Date.now()}-${n++}`;
    const c = cookieClient();
    expect((await c.post('/host/openwop-app/test/login', { email: `k-${Date.now()}@a.test`, tenantId })).status).toBe(201);
    const contact = await c.post('/host/openwop-app/crm/contacts', { name: 'KeyTest', email: 'k@x.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    // ADR 0795 D2 — this test used to mint `manifest:read` and then read CRM
    // contacts with it: it PINNED the gap (a vendor route ignored the key's
    // declaration). A key reads the workspace by declaring `workspace:read`.
    const narrow = await c.post('/host/openwop-app/developer-keys', { name: 'narrow', scopes: ['manifest:read'] });
    const refused = await bearerGet('/host/openwop-app/crm/contacts', narrow.body.token as string);
    expect(refused.status).toBe(403);
    // The ADR 0795 D2 vendor gate's own refusal — not some other route's 403.
    expect(refused.body.details?.code).toBe('key_scope_required');
    const issued = await c.post('/host/openwop-app/developer-keys', { name: 'ci', scopes: ['workspace:read'] });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const token = issued.body.token as string;
    const keyId = issued.body.key!.keyId;

    // VALID key (cookieless Bearer) → sees the tenant's contact
    const ok = await bearerGet('/host/openwop-app/crm/contacts', token);
    expect(ok.status).toBe(200);
    expect(hasContact(ok.body, contactId)).toBe(true);

    // INVALID key → NOT authenticated as the tenant (fail-closed)
    const bad = await bearerGet('/host/openwop-app/crm/contacts', 'owk_totally-bogus');
    expect(bad.status, JSON.stringify(bad.body)).toBe(401);
    expect(bad.body.error).toBe('unauthenticated');
    expect(hasContact(bad.body, contactId)).toBe(false);

    // REVOKED key → no longer authenticates
    expect((await c.del(`/host/openwop-app/developer-keys/${keyId}`)).status).toBe(204);
    const revoked = await bearerGet('/host/openwop-app/crm/contacts', token);
    // RFC 0170 `revocation: next-request` — refused as REVOKED, not as an unknown bearer.
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(401);
    expect(revoked.body.message).toBe('This API key was revoked.');
    expect(hasContact(revoked.body, contactId)).toBe(false);
  });
});
