/**
 * CDP-A — customer identity resolution (ADR 0263). ROUTE-level harness (mirrors
 * crm-lifecycle.test.ts). Covers:
 *   - resolve a customer by email (the seeded index kills the linear scan)
 *   - add a non-email identifier (phone) → resolve by it → same contact
 *   - normalization (phone punctuation, email case) resolves
 *   - merge: source's email resolves to the SURVIVOR (tombstone followed) + union
 *   - remove identifier → no longer resolves
 *   - toggle OFF ⇒ /cdp/identity/resolve 404 (backend authority)
 *   - tenant isolation: another tenant cannot resolve a foreign identifier
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { linkSession } from '../src/features/analytics/identityLinkService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T; headers: Headers }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const cRaw of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(cRaw);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out, headers: res.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `cdp-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault(id);
  if (def) await saveConfig({ ...def, status }, 'test');
};
const resolve = (c: Client, type: string, value: string) =>
  c.get(`/v1/host/openwop-app/cdp/identity/resolve?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`);

async function owner(): Promise<Client> {
  const tenantId = `org:cdp-${Date.now()}-${n++}`;
  const c = client();
  await signup(c, tenantId);
  return c;
}

describe('CDP-A identity resolution', () => {
  it('resolves a customer by email (case-insensitive) and by an added phone identifier', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const created = await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Ada', email: 'Ada@Acme.TEST' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.contactId;

    const byEmail = await resolve(c, 'email', 'ada@acme.test');
    expect(byEmail.status, JSON.stringify(byEmail.body)).toBe(200);
    expect(byEmail.body.contact.contactId).toBe(id);
    expect(byEmail.body.resolvedBy).toEqual({ type: 'email', value: 'ada@acme.test' });

    const add = await c.post(`/v1/host/openwop-app/crm/contacts/${id}/identifiers`, { type: 'phone', value: '+1 (555) 123-4567' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    const byPhone = await resolve(c, 'phone', '+15551234567');
    expect(byPhone.status, JSON.stringify(byPhone.body)).toBe(200);
    expect(byPhone.body.contact.contactId).toBe(id);
  });

  it('follows a merge tombstone: the source email resolves to the survivor + unions identifiers', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const survivor = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'S', email: 'survivor@acme.test' })).body;
    const source = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'D', email: 'source@acme.test' })).body;
    await c.post(`/v1/host/openwop-app/crm/contacts/${source.contactId}/identifiers`, { type: 'loyalty', value: 'LOY-9' });

    const merged = await c.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: source.contactId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);

    // the source's email now resolves to the SURVIVOR (tombstone followed)
    const bySourceEmail = await resolve(c, 'email', 'source@acme.test');
    expect(bySourceEmail.status).toBe(200);
    expect(bySourceEmail.body.contact.contactId).toBe(survivor.contactId);
    // the source's loyalty id was absorbed
    const byLoyalty = await resolve(c, 'loyalty', 'LOY-9');
    expect(byLoyalty.status).toBe(200);
    expect(byLoyalty.body.contact.contactId).toBe(survivor.contactId);
  });

  it('removing an identifier stops resolving it', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const id = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'R', email: 'r@acme.test' })).body.contactId;
    await c.post(`/v1/host/openwop-app/crm/contacts/${id}/identifiers`, { type: 'device', value: 'dev-1' });
    expect((await resolve(c, 'device', 'dev-1')).status).toBe(200);
    const del = await c.del(`/v1/host/openwop-app/crm/contacts/${id}/identifiers?type=device&value=dev-1`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await resolve(c, 'device', 'dev-1')).status).toBe(404);
  });

  it('is toggle-gated: cdp OFF ⇒ resolve 404 even for a known identifier', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'G', email: 'gate@acme.test' });
    expect((await resolve(c, 'email', 'gate@acme.test')).status).toBe(200);
    await setToggle('cdp', 'off');
    expect((await resolve(c, 'email', 'gate@acme.test')).status).toBe(404);
    await setToggle('cdp', 'on');
  });

  it('is tenant-isolated: another tenant cannot resolve a foreign identifier', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const a = await owner();
    await a.post('/v1/host/openwop-app/crm/contacts', { name: 'Priv', email: 'priv@acme.test' });
    const b = await owner();
    expect((await resolve(b, 'email', 'priv@acme.test')).status).toBe(404);
  });

  it('rejects an unknown identifier type at the write boundary', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const id = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'X', email: 'x@acme.test' })).body.contactId;
    const bad = await c.post(`/v1/host/openwop-app/crm/contacts/${id}/identifiers`, { type: 'passport', value: 'P1' });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
  });

  it('anon→known: a cookie/session key resolves to its linked contact (ADR 0263 P2)', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const tenantId = `org:cdp-${Date.now()}-${n++}`;
    const c = client();
    await signup(c, tenantId);
    const id = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Anon', email: 'anon@acme.test' })).body.contactId;
    // an anonymous analytics session (cookie) is later linked to the known contact
    const sessionKey = `sess-${Date.now()}-${n}`;
    await linkSession(tenantId, sessionKey, id, 'email-click');
    // resolve by cookie → the linked contact (read-only compose over the identity-link)
    const byCookie = await resolve(c, 'cookie', sessionKey);
    expect(byCookie.status, JSON.stringify(byCookie.body)).toBe(200);
    expect(byCookie.body.contact.contactId).toBe(id);
  });
});
