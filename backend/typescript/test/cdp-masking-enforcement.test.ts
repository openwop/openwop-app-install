/**
 * CDP-F — field-masking enforcement at the CDP resolve seam (ADR 0268). An
 * interactive user session sees the unmasked golden record; a programmatic API-key
 * caller sees PII (name/email) masked. Composes CDP-A (resolve) + CDP-H (key auth)
 * + CDP-F (masker).
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
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'cdp', 'developer-keys']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function cookieClient() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown) => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function bearerGet(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => undefined) as any };
}
let n = 0;

describe('CDP-F masking enforcement', () => {
  it('user session sees unmasked PII; API-key caller sees masked PII', async () => {
    const tenantId = `org:mask-${Date.now()}-${n++}`;
    const c = cookieClient();
    expect((await c.post('/v1/host/openwop-app/test/login', { email: `m-${Date.now()}@a.test`, tenantId })).status).toBe(201);
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Ada Lovelace', email: 'ada@acme.test' });

    const resolvePath = '/v1/host/openwop-app/cdp/identity/resolve?type=email&value=ada@acme.test';

    // interactive user session → unmasked
    const asUser = await c.get(resolvePath);
    expect(asUser.status).toBe(200);
    expect(asUser.body.contact.email).toBe('ada@acme.test');
    expect(asUser.body.contact.name).toBe('Ada Lovelace');

    // programmatic API-key → masked PII
    const token = (await c.post('/v1/host/openwop-app/developer-keys', { name: 'ci' })).body.token as string;
    const asKey = await bearerGet(resolvePath, token);
    expect(asKey.status).toBe(200);
    expect(asKey.body.contact.email).toMatch(/^pii_/);
    expect(asKey.body.contact.name).toMatch(/^pii_/);
    expect(asKey.body.contact.email).not.toBe('ada@acme.test');
    // still resolves to the same customer (contactId not masked)
    expect(asKey.body.contact.contactId).toBe(asUser.body.contact.contactId);
    // R2 CDP-G5 — the route DISCLOSES the masking (Segment PII-Access
    // convention: masked renders as masked, never silently pseudonymized).
    expect(asKey.body.masked).toBe(true);
    expect(asUser.body.masked).toBe(false);
  });
});
