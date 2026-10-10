/**
 * ADR 0799 — sign the CLI in without copying a key. The whole flow over HTTP:
 * the CLI starts and polls with no credential, a signed-in person approves by
 * the code their terminal shows, and the key is minted once, at the poll.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { issueApiKey, listApiKeys, setTenantKeyPolicy } from '../src/features/developer-keys/apiKeyService.js';
import { invalidateTenantKeyPolicyCache } from '../src/features/developer-keys/tenantKeyPolicyCache.js';
import { __resetCliLoginRateLimitForTest } from '../src/features/developer-keys/cliLoginRoutes.js';
import { listChain } from '../src/host/auditChainService.js';

const H = '/host/openwop-app';
const CL = `${H}/cli-login`;
const DAY = 86_400_000;
let BASE = ''; let server: http.Server;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_DEMO_MODE']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_DEMO_MODE = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0799', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
beforeEach(() => { __resetCliLoginRateLimitForTest(); });
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

interface Res { status: number; body: any; headers: Headers }
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', connection: 'close', ...(cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined), headers: res.headers };
  };
}
const cli = client(); // never logs in: the CLI has no credential until the flow ends
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function person(tag: string): Promise<{ call: ReturnType<typeof client>; userId: string; tenant: string }> {
  const call = client();
  const login = await call('POST', `${H}/test/login`, { email: `${tag}-${Date.now()}@a.test` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const me = await call('GET', `${H}/developer-keys`);
  expect(me.status).toBe(200);
  return { call, userId: login.body.user.userId as string, tenant: (login.body.tenantId ?? login.body.user.personalTenant ?? '') as string };
}

describe('ADR 0799 — the CLI signs in by a code the person types', () => {
  it('start needs no credential and returns a secret device code, a typeable user code, and a link WITHOUT the code', async () => {
    const r = await cli('POST', `${CL}/start`, { label: 'laptop' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.deviceCode).toMatch(/^owcl_/);
    expect(r.body.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    expect(r.body.verificationPath).toBe('/access?tab=api-keys');
    expect(JSON.stringify(r.body.verificationPath)).not.toContain(r.body.userCode);
    expect((await cli('POST', `${CL}/poll`, { deviceCode: r.body.deviceCode })).body).toEqual({ status: 'pending', interval: 3 });
  });

  it('approve → the key is delivered ONCE, works for the protocol and the workspace, and is the approver’s own', async () => {
    const p = await person('approver');
    const s = (await cli('POST', `${CL}/start`, { label: 'laptop' })).body;
    const shown = await p.call('GET', `${CL}/requests/${s.userCode}`);
    expect(shown.status).toBe(200);
    expect(shown.body.request).toMatchObject({ userCode: s.userCode, label: 'laptop' });
    expect(JSON.stringify(shown.body)).not.toContain(s.deviceCode);
    // Typed loosely (lower case, no dash): the same code.
    expect((await p.call('POST', `${CL}/requests/${s.userCode.toLowerCase().replace('-', '')}/approve`, {})).status).toBe(204);

    const got = await cli('POST', `${CL}/poll`, { deviceCode: s.deviceCode });
    expect(got.status).toBe(200);
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(got.body.status).toBe('approved');
    const token = got.body.token as string;
    expect(token).toMatch(/^owk_/);
    expect((await cli('POST', `${CL}/poll`, { deviceCode: s.deviceCode })).status, 'collected once').toBe(404);

    expect((await cli('GET', '/runs', undefined, bearer(token))).status).toBe(200);
    expect((await cli('GET', `${H}/roster`, undefined, bearer(token))).status).toBe(200);

    const listed = (await p.call('GET', `${H}/developer-keys`)).body.keys.find((k: { keyId: string }) => k.keyId === got.body.key.keyId);
    expect(listed).toMatchObject({ name: 'CLI: laptop', mine: true });
    const left = Date.parse(listed.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(29 * DAY);
    expect(left).toBeLessThanOrEqual(30 * DAY);
    const tenant = got.body.key.tenantId as string;
    expect((await listChain(tenant)).some((e) => e.kind === 'apikey.created' && (e.payload as { via?: string; keyId?: string }).via === 'cli-login' && (e.payload as { keyId?: string }).keyId === listed.keyId)).toBe(true);
  });

  it('two polls racing get ONE key between them', async () => {
    const p = await person('race');
    const s = (await cli('POST', `${CL}/start`, {})).body;
    await p.call('POST', `${CL}/requests/${s.userCode}/approve`, {});
    const [a, b] = await Promise.all([cli('POST', `${CL}/poll`, { deviceCode: s.deviceCode }), cli('POST', `${CL}/poll`, { deviceCode: s.deviceCode })]);
    expect([a, b].filter((r) => r.status === 200 && r.body.status === 'approved').length).toBe(1);
    expect([a, b].filter((r) => r.status === 404).length).toBe(1);
  });

  it('deny → the CLI is told, and no key exists', async () => {
    const p = await person('denier');
    const s = (await cli('POST', `${CL}/start`, { label: 'someone-elses' })).body;
    expect((await p.call('POST', `${CL}/requests/${s.userCode}/deny`, {})).status).toBe(204);
    expect((await cli('POST', `${CL}/poll`, { deviceCode: s.deviceCode })).body).toEqual({ status: 'denied' });
    expect((await p.call('GET', `${H}/developer-keys`)).body.keys.some((k: { name: string }) => k.name === 'CLI: someone-elses')).toBe(false);
    // Decided once: it cannot be approved afterwards.
    expect((await p.call('POST', `${CL}/requests/${s.userCode}/approve`, {})).status).toBe(404);
  });
});

describe('ADR 0827 — the approval link is absolute, on the WEB origin', () => {
  it('verificationUri is OPENWOP_PUBLIC_BASE_URL origin + verificationPath, never carries the code, and is omitted when unset or not http(s)', async () => {
    const prior = process.env.OPENWOP_PUBLIC_BASE_URL;
    try {
      delete process.env.OPENWOP_PUBLIC_BASE_URL;
      const none = await cli('POST', `${CL}/start`, {});
      expect(none.status).toBe(201);
      expect(none.body.verificationUri).toBeUndefined();
      expect(none.body.verificationPath).toBe('/access?tab=api-keys');

      // A protocol-origin CLI (api.<host>) must be sent to the SPA origin, and
      // only the origin of the configured URL counts (no path smuggling).
      process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.test/some/path/';
      const set = await cli('POST', `${CL}/start`, {});
      expect(set.body.verificationUri).toBe('https://app.example.test/access?tab=api-keys');
      expect(set.body.verificationUri).not.toContain(set.body.userCode);

      process.env.OPENWOP_PUBLIC_BASE_URL = 'javascript:alert(1)';
      expect((await cli('POST', `${CL}/start`, {})).body.verificationUri).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL; else process.env.OPENWOP_PUBLIC_BASE_URL = prior;
    }
  });
});

describe('ADR 0799 — who may approve', () => {
  it('nobody without a signed-in person: no credential, an anonymous session, and a key are all refused', async () => {
    const s = (await cli('POST', `${CL}/start`, {})).body;
    expect((await client()('POST', `${CL}/requests/${s.userCode}/approve`, {})).status).toBe(401);
    const p = await person('keyholder');
    const key = (await p.call('POST', `${H}/developer-keys`, { name: 'k', scopes: ['*'] })).body.token as string;
    expect((await cli('POST', `${CL}/requests/${s.userCode}/approve`, {}, bearer(key))).status).toBe(401);
    expect((await cli('GET', `${CL}/requests/${s.userCode}`, undefined, bearer(key))).status).toBe(401);
    expect((await cli('POST', `${CL}/poll`, { deviceCode: s.deviceCode })).body.status, 'still pending').toBe('pending');
  });

  it('an unknown or malformed code is a uniform 404, for looking and for deciding', async () => {
    const p = await person('guesser');
    for (const code of ['ZZZZ-ZZZZ', 'nope', '../x']) {
      expect((await p.call('GET', `${CL}/requests/${encodeURIComponent(code)}`)).status, code).toBe(404);
      expect((await p.call('POST', `${CL}/requests/${encodeURIComponent(code)}/approve`, {})).status, code).toBe(404);
    }
    expect((await cli('POST', `${CL}/poll`, { deviceCode: 'owcl_not-a-real-one' })).status).toBe(404);
    expect((await cli('POST', `${CL}/poll`, { deviceCode: 42 })).status).toBe(404);
  });

  it('a workspace with keys turned off cannot approve one', async () => {
    const p = await person('off');
    const probe = await issueApiKey({ tenantId: 'adr0799-probe', name: 'x', createdBy: 'user:x' });
    void probe;
    const mine = (await p.call('POST', `${H}/developer-keys`, { name: 'find-tenant', scopes: ['runs:read'] })).body.key.tenantId as string;
    await setTenantKeyPolicy(mine, { disabled: true }, 'test');
    invalidateTenantKeyPolicyCache();
    const s = (await cli('POST', `${CL}/start`, {})).body;
    const r = await p.call('POST', `${CL}/requests/${s.userCode}/approve`, {});
    expect(r.status).toBe(403);
    expect(r.body.details?.code).toBe('keys_disabled');
    await setTenantKeyPolicy(mine, { disabled: false }, 'test');
    invalidateTenantKeyPolicyCache();
  });

  it('an address is limited to a handful of starts', async () => {
    for (let i = 0; i < 10; i++) expect((await cli('POST', `${CL}/start`, {})).status).toBe(201);
    const eleventh = await cli('POST', `${CL}/start`, {});
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get('retry-after')).toBeTruthy();
  });
});

describe('ADR 0799 — sign out: a key may revoke itself, and only itself', () => {
  it('logout with the key stops that key and leaves the person’s other keys alone', async () => {
    const p = await person('logout');
    const other = (await p.call('POST', `${H}/developer-keys`, { name: 'other', scopes: ['runs:read'] })).body;
    const s = (await cli('POST', `${CL}/start`, { label: 'to-sign-out' })).body;
    await p.call('POST', `${CL}/requests/${s.userCode}/approve`, {});
    const token = (await cli('POST', `${CL}/poll`, { deviceCode: s.deviceCode })).body.token as string;
    expect((await cli('POST', `${CL}/logout`, {}, bearer(token))).status).toBe(204);
    expect((await cli('GET', '/runs', undefined, bearer(token))).status).toBe(401);
    expect((await cli('GET', '/runs', undefined, bearer(other.token))).status).toBe(200);
  });

  it('a narrow key can sign itself out too; a session cannot use the route; a key still cannot manage OTHER keys', async () => {
    const p = await person('narrow');
    const narrow = (await p.call('POST', `${H}/developer-keys`, { name: 'narrow', scopes: ['runs:read'] })).body;
    const victim = (await p.call('POST', `${H}/developer-keys`, { name: 'victim', scopes: ['runs:read'] })).body;
    expect((await cli('DELETE', `${H}/developer-keys/${encodeURIComponent(victim.key.keyId)}`, undefined, bearer(narrow.token))).status).toBe(403);
    expect((await p.call('POST', `${CL}/logout`, {})).status).toBe(400);
    expect((await cli('POST', `${CL}/logout`, {}, bearer(narrow.token))).status).toBe(204);
    expect((await cli('GET', '/runs', undefined, bearer(narrow.token))).status).toBe(401);
    const tenant = narrow.key.tenantId as string;
    const live = (await listApiKeys(tenant, { callerSubject: 'x', isAdmin: true })).filter((k) => !k.revokedAt).map((k) => k.name);
    expect(live).toContain('victim');
    expect(live).not.toContain('narrow');
  });
});
