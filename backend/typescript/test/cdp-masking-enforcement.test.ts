/**
 * CDP-F — field-masking enforcement at the CDP resolve seam (ADR 0268). An
 * interactive user session sees the unmasked golden record; a programmatic API-key
 * caller sees PII (name/email) masked. Composes CDP-A (resolve) + CDP-H (key auth)
 * + CDP-F (masker).
 *
 * Sabotage that reds it (w38 probes): granting PII to every caller; denying it to
 * every caller; the classification policy never masking; the route hiding the
 * `masked` disclosure; the golden-record masker passing the contact through.
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
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as unknown };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function bearerGet(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as unknown };
}
interface ResolveBody { contact: { contactId: string; name: string; email: string }; masked: boolean }
const resolved = (r: { body: unknown }): ResolveBody => r.body as ResolveBody;
let n = 0;

describe('CDP-F masking enforcement', () => {
  it('user session sees unmasked PII; API-key caller sees masked PII', async () => {
    const tenantId = `org:mask-${Date.now()}-${n++}`;
    const c = cookieClient();
    expect((await c.post('/host/openwop-app/test/login', { email: `m-${Date.now()}@a.test`, tenantId })).status).toBe(201);
    expect((await c.post('/host/openwop-app/crm/contacts', { name: 'Ada Lovelace', email: 'ada@acme.test' })).status).toBe(201);

    const resolvePath = '/host/openwop-app/cdp/identity/resolve?type=email&value=ada@acme.test';

    // interactive user session → unmasked
    const asUser = await c.get(resolvePath);
    expect(asUser.status).toBe(200);
    expect(resolved(asUser).contact.email).toBe('ada@acme.test');
    expect(resolved(asUser).contact.name).toBe('Ada Lovelace');

    // programmatic API-key → masked PII
    // ADR 0795 D2/D3 — a key names its scopes, and reading the workspace is one.
    const minted = await c.post('/host/openwop-app/developer-keys', { name: 'ci', scopes: ['workspace:read'] });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const token = (minted.body as { token: string }).token;
    expect(typeof token).toBe('string');
    const asKey = await bearerGet(resolvePath, token);
    expect(asKey.status).toBe(200);
    expect(resolved(asKey).contact.email).toMatch(/^pii_/);
    expect(resolved(asKey).contact.name).toMatch(/^pii_/);
    expect(resolved(asKey).contact.email).not.toBe('ada@acme.test');
    // still resolves to the same customer (contactId not masked)
    expect(resolved(asKey).contact.contactId).toBe(resolved(asUser).contact.contactId);
    // R2 CDP-G5 — the route DISCLOSES the masking (Segment PII-Access
    // convention: masked renders as masked, never silently pseudonymized).
    expect(resolved(asKey).masked).toBe(true);
    expect(resolved(asUser).masked).toBe(false);
  });
});
