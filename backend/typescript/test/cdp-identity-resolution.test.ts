/**
 * CDP-A — customer identity resolution (ADR 0263). ROUTE-level harness (mirrors
 * crm-lifecycle.test.ts). Covers:
 *   - resolve a customer by email (the seeded index kills the linear scan)
 *   - add a non-email identifier (phone) → resolve by it → same contact
 *   - normalization (phone punctuation, email case) resolves
 *   - remove identifier → no longer resolves
 *   - toggle OFF ⇒ /cdp/identity/resolve 404 (backend authority)
 *   - tenant isolation: another tenant cannot resolve a foreign identifier
 *
 * Merge resolution lives in cdp-identity-merge-provenance.test.ts ("a CLEANLY merged
 * email is re-pointed…", "an absorbed non-email identifier…" for the merge re-point;
 * "a STALE index key…" for the tombstone-follow). The merge case that used to sit here
 * was cut in w38: it could not fail — re-point AND tombstone-follow both delivered the
 * survivor, and its probe stayed green while those provenance cases went red.
 *
 * Sabotage that reds it (w38 probes): dropping the toggle gate; phone normalization;
 * stale-key deletion on identifier removal; the cookie → identity-link fallback; the
 * identifier-type check at the write boundary.
 *
 * TRIPLE GUARD (honest ceiling) on tenant isolation: the index key is tenant-prefixed,
 * `resolveContactIdByIdentifier` re-checks `row.tenantId`, and `resolveIdentity`
 * re-checks `contact.tenantId` (the legacy email scan is tenant-scoped too). No single
 * sabotage turns the isolation case red (w38 `ir-tenant`); it is kept with positive
 * controls so it at least proves each tenant reaches its OWN record. The route has no
 * org/member gate (the rolodex is tenant-wide), so a same-tenant non-member case does
 * not apply here.
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

interface Res { status: number; body: unknown; headers: Headers }
interface GoldenBody { contact: { contactId: string }; resolvedBy: { type: string; value: string } }
const golden = (r: Res): GoldenBody => r.body as GoldenBody;
const idOf = (r: Res): string => (r.body as { contactId: string }).contactId;
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
  const r = await c.post('/host/openwop-app/test/login', { email: `cdp-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault(id);
  if (def) await saveConfig({ ...def, status }, 'test');
};
const resolve = (c: Client, type: string, value: string) =>
  c.get(`/host/openwop-app/cdp/identity/resolve?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`);

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
    const created = await c.post('/host/openwop-app/crm/contacts', { name: 'Ada', email: 'Ada@Acme.TEST' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = idOf(created);

    const byEmail = await resolve(c, 'email', 'ada@acme.test');
    expect(byEmail.status, JSON.stringify(byEmail.body)).toBe(200);
    expect(golden(byEmail).contact.contactId).toBe(id);
    expect(golden(byEmail).resolvedBy).toEqual({ type: 'email', value: 'ada@acme.test' });

    const add = await c.post(`/host/openwop-app/crm/contacts/${id}/identifiers`, { type: 'phone', value: '+1 (555) 123-4567' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    const byPhone = await resolve(c, 'phone', '+15551234567');
    expect(byPhone.status, JSON.stringify(byPhone.body)).toBe(200);
    expect(golden(byPhone).contact.contactId).toBe(id);
  });

  it('removing an identifier stops resolving it', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const id = idOf(await c.post('/host/openwop-app/crm/contacts', { name: 'R', email: 'r@acme.test' }));
    expect((await c.post(`/host/openwop-app/crm/contacts/${id}/identifiers`, { type: 'device', value: 'dev-1' })).status).toBe(201);
    expect((await resolve(c, 'device', 'dev-1')).status).toBe(200);
    const del = await c.del(`/host/openwop-app/crm/contacts/${id}/identifiers?type=device&value=dev-1`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await resolve(c, 'device', 'dev-1')).status).toBe(404);
  });

  it('is toggle-gated: cdp OFF ⇒ resolve 404 even for a known identifier', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    expect((await c.post('/host/openwop-app/crm/contacts', { name: 'G', email: 'gate@acme.test' })).status).toBe(201);
    expect((await resolve(c, 'email', 'gate@acme.test')).status).toBe(200);
    await setToggle('cdp', 'off');
    try {
      const off = await resolve(c, 'email', 'gate@acme.test');
      expect(off.status).toBe(404);
      expect(off.body).toMatchObject({ error: 'not_found', message: 'CDP is not enabled for this tenant.' });
    } finally {
      await setToggle('cdp', 'on');
    }
  });

  it('is tenant-isolated: another tenant cannot resolve a foreign identifier', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    // REAL records in BOTH tenants: the same email in each, plus an A-only identifier.
    const a = await owner();
    const aId = idOf(await a.post('/host/openwop-app/crm/contacts', { name: 'Priv', email: 'priv@acme.test' }));
    expect((await a.post(`/host/openwop-app/crm/contacts/${aId}/identifiers`, { type: 'loyalty', value: 'LOY-A-ONLY' })).status).toBe(201);
    const b = await owner();
    const bId = idOf(await b.post('/host/openwop-app/crm/contacts', { name: 'Other', email: 'priv@acme.test' }));
    expect(bId).not.toBe(aId);
    // positive controls: each tenant reaches its OWN record by the shared email
    expect(golden(await resolve(a, 'email', 'priv@acme.test')).contact.contactId).toBe(aId);
    expect(golden(await resolve(b, 'email', 'priv@acme.test')).contact.contactId).toBe(bId);
    expect(golden(await resolve(a, 'loyalty', 'LOY-A-ONLY')).contact.contactId).toBe(aId);
    // B cannot reach A's identifier
    const foreign = await resolve(b, 'loyalty', 'LOY-A-ONLY');
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ error: 'not_found', message: 'No customer resolves to that identifier.' });
  });

  it('rejects an unknown identifier type at the write boundary', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const id = idOf(await c.post('/host/openwop-app/crm/contacts', { name: 'X', email: 'x@acme.test' }));
    const bad = await c.post(`/host/openwop-app/crm/contacts/${id}/identifiers`, { type: 'passport', value: 'P1' });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(bad.body).toMatchObject({ error: 'validation_error', message: "Unknown identifier type 'passport'." });
  });

  it('anon→known: a cookie/session key resolves to its linked contact (ADR 0263 P2)', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const tenantId = `org:cdp-${Date.now()}-${n++}`;
    const c = client();
    await signup(c, tenantId);
    const id = idOf(await c.post('/host/openwop-app/crm/contacts', { name: 'Anon', email: 'anon@acme.test' }));
    // an anonymous analytics session (cookie) is later linked to the known contact
    const sessionKey = `sess-${Date.now()}-${n}`;
    await linkSession(tenantId, sessionKey, id, 'email-click');
    // resolve by cookie → the linked contact (read-only compose over the identity-link)
    const byCookie = await resolve(c, 'cookie', sessionKey);
    expect(byCookie.status, JSON.stringify(byCookie.body)).toBe(200);
    expect(golden(byCookie).contact.contactId).toBe(id);
  });
});
