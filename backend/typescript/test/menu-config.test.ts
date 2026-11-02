/**
 * Navigation-settings routes (ADR 0139) — the host-extension menu-layout store.
 * Drives over HTTP: the authed combined GET, the superadmin gate on the tenant
 * PUT, the caller-scoped `me` PUT, per-user/tenant isolation, and validation
 * rejects. Superadmin = the wildcard bearer (admin key), matching
 * test/site-config.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // only the wildcard bearer is superadmin
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** A signed-in but NON-superadmin caller (personal tenant), via the test seam.
 *  Captures the `__session` cookie specifically (the session identity), matching
 *  the working route-test harnesses (e.g. test/priority-matrix-route.test.ts). */
async function normalClient(tenantId?: string): Promise<(method: string, path: string, body?: unknown) => Promise<Response>> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(ck);
      if (m?.[1]) cookie = m[1];
    }
    return res;
  };
  const login = await call('POST', '/host/openwop-app/test/login', { email: `mc-${n++}@x.test`, ...(tenantId ? { tenantId } : {}) });
  expect(login.status).toBe(201);
  return call;
}

const BASE_PATH = '/host/openwop-app/menu-config';

describe('menu-config — authentication', () => {
  it('GET for an anonymous caller returns its own (empty) tenant layer — never a 401', async () => {
    // Day-1 UX P2: the nav rail reads this on every paint; anonymous sessions
    // used to 401 here (pure console/network noise, swallowed client-side).
    // An anonymous caller reads only its OWN tenant layer; writes stay gated.
    const res = await fetch(`${BASE}${BASE_PATH}`);
    expect(res.status).toBe(200);
    const body = await j<{ tenant: unknown }>(res);
    expect(body.tenant).toEqual({ items: {}, headers: [] });
  });

  it('returns empty layers for a fresh caller', async () => {
    const call = await normalClient();
    const res = await call('GET', BASE_PATH);
    expect(res.status).toBe(200);
    const body = await j<{ tenant: unknown; user: unknown }>(res);
    expect(body.tenant).toEqual({ items: {}, headers: [] });
    expect(body.user).toEqual({ items: {}, headers: [] });
  });
});

describe('menu-config — tenant layer (superadmin)', () => {
  it('rejects a tenant PUT from a non-superadmin (403)', async () => {
    const call = await normalClient();
    const res = await call('PUT', `${BASE_PATH}/tenant`, { config: { items: {}, headers: [] } });
    expect(res.status).toBe(403);
  });

  it('accepts a tenant PUT from the superadmin bearer + reads it back', async () => {
    const cfg = { items: { '/leaderboard': { tier: 'admin', group: 'Platform' } }, headers: [{ id: 'Platform', tier: 'admin', label: 'Tooling' }] };
    const put = await admin('PUT', `${BASE_PATH}/tenant`, { config: cfg });
    expect(put.status).toBe(200);
    const got = await admin('GET', BASE_PATH);
    const body = await j<{ tenant: { items: Record<string, unknown> } }>(got);
    expect(body.tenant.items['/leaderboard']).toEqual({ tier: 'admin', group: 'Platform' });
  });
});

describe('menu-config — user layer (caller-scoped)', () => {
  it("a user PUT writes only the caller's own layer; another user is unaffected", async () => {
    // SAME tenant: the user layer is keyed (tenant, user), so the isolation
    // that matters is between two users of ONE workspace. (With each user in
    // their own personal tenant — the old fixture — dropping the userId from
    // the key stayed green: MEASURED w72 probe mcfg-userkey.)
    const shared = `mc-shared-${Date.now()}-${n++}`;
    const alice = await normalClient(shared);
    const bob = await normalClient(shared);
    const put = await alice('PUT', `${BASE_PATH}/me`, { config: { items: { '/widgets': { hidden: true } }, headers: [] } });
    expect(put.status).toBe(200);

    const aliceGot = await j<{ user: { items: Record<string, unknown> } }>(await alice('GET', BASE_PATH));
    expect(aliceGot.user.items['/widgets']).toEqual({ hidden: true });

    const bobGot = await j<{ user: { items: Record<string, unknown> } }>(await bob('GET', BASE_PATH));
    expect(bobGot.user.items).toEqual({});
    // Positive control: Bob's own write lands in Bob's layer, not Alice's.
    expect((await bob('PUT', `${BASE_PATH}/me`, { config: { items: { '/gadgets': { hidden: true } }, headers: [] } })).status).toBe(200);
    const aliceAgain = await j<{ user: { items: Record<string, unknown> } }>(await alice('GET', BASE_PATH));
    expect(aliceAgain.user.items).toEqual({ '/widgets': { hidden: true } });
  });
});

describe('menu-config — validation (fail closed)', () => {
  /** A refused PUT is the validator's refusal (code + the field it names), not
   *  any 400. The caller-scoped `me` lane is used so the check is independent
   *  of the shared tenant layer other cases write. */
  const refused = async (config: unknown, field: string): Promise<void> => {
    const call = await normalClient();
    const res = await call('PUT', `${BASE_PATH}/me`, { config });
    expect(res.status).toBe(400);
    const body = await j<{ error?: string; details?: { field?: string } }>(res);
    expect(body.error).toBe('validation_error');
    expect(body.details?.field).toBe(field);
    // Nothing was written.
    const got = await j<{ user: unknown }>(await call('GET', BASE_PATH));
    expect(got.user).toEqual({ items: {}, headers: [] });
  };

  it('rejects a bad tier', async () => {
    await refused({ items: { '/x': { tier: 'sidebar' } }, headers: [] }, 'items["/x"].tier');
  });

  it('rejects a header without a tier', async () => {
    await refused({ items: {}, headers: [{ id: 'hdr_1' }] }, 'headers[].tier');
  });

  it('rejects a non-object config', async () => {
    await refused('nope', 'config');
  });

  it('strips unknown override fields (normalizes to the known shape)', async () => {
    const call = await normalClient();
    expect((await call('PUT', `${BASE_PATH}/me`, { config: { items: { '/x': { tier: 'admin', bogus: 1 } }, headers: [] } })).status).toBe(200);
    const got = await j<{ user: { items: Record<string, unknown> } }>(await call('GET', BASE_PATH));
    expect(got.user.items['/x']).toEqual({ tier: 'admin' });
  });

  it('CHN-6: a stale If-Match on the tenant PUT is 409; the current ETag succeeds', async () => {
    const cfg = { items: {}, headers: [] };
    const put1 = await admin('PUT', `${BASE_PATH}/tenant`, { config: cfg });
    expect(put1.status).toBe(200);
    const v1 = put1.headers.get('etag');
    expect(v1).toBeTruthy();
    // A stale If-Match (an old version tag) must be rejected, not silently clobber.
    const stale = await fetch(`${BASE}${BASE_PATH}/tenant`, {
      method: 'PUT', headers: { ...ADMIN, 'If-Match': '"1999-01-01T00:00:00.000Z"' }, body: JSON.stringify({ config: cfg }),
    });
    expect(stale.status).toBe(409);
    // The current ETag is accepted.
    const ok = await fetch(`${BASE}${BASE_PATH}/tenant`, {
      method: 'PUT', headers: { ...ADMIN, 'If-Match': v1! }, body: JSON.stringify({ config: cfg }),
    });
    expect(ok.status).toBe(200);
    // (Not asserted to differ from v1: the version is the write's ISO
    // timestamp, and two writes inside one millisecond share it.)
    expect(ok.headers.get('etag')).toBeTruthy();
  });
});
