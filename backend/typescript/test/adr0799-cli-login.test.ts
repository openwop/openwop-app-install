/**
 * ADR 0799 — sign the CLI in without copying a key. The whole flow over HTTP:
 * the CLI starts and polls with no credential, a signed-in person approves by
 * the code their terminal shows, and the key is minted once, at the poll.
 * Tracker: TST-BAK-3.
 *
 * Red when (wave 60 probes w60g4-cli-*): the poll's claim stops consuming the
 * request, or the claim is a blind put instead of a compare-and-swap (the race
 * case HOLDS the first poll on its read until the second arrives, so the two
 * really contend); the key is not the approver's, outlives 30 days, is served
 * cacheable, or is audited without `via: cli-login`; the typed code is not
 * normalised; a denial is not reported, or a decided request can be decided
 * again; a key or an anonymous session may approve; a workspace with keys off
 * may approve; starts are unthrottled; the web-origin link keeps a path or a
 * non-http(s) scheme; logout stops revoking the presented key.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { listApiKeys, setTenantKeyPolicy, type ApiKeyPublic } from '../src/features/developer-keys/apiKeyService.js';
import { invalidateTenantKeyPolicyCache } from '../src/features/developer-keys/tenantKeyPolicyCache.js';
import { __resetCliLoginRateLimitForTest } from '../src/features/developer-keys/cliLoginRoutes.js';
import type { CliLoginPoll } from '../src/features/developer-keys/cliLogin.js';
import { listChain } from '../src/host/auditChainService.js';
import { hashToken } from '../src/host/capabilityToken.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

const H = '/host/openwop-app';
const CL = `${H}/cli-login`;
const DAY = 86_400_000;
const NOT_A_PERSON = 'Approving a CLI sign-in requires a signed-in person.';
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

/** The response shapes this file reads, each typed at the call site. */
interface ErrorBody { error?: string; message?: string; details?: { code?: string } }
interface Started { deviceCode: string; userCode: string; expiresIn: number; interval: number; verificationPath: string; verificationUri?: string }
interface Shown { request: { userCode: string; label: string; requestedFrom: string }; workspaceId: string }
interface Login { user: { userId: string; personalTenant?: string }; tenantId?: string }
interface Minted { token: string; key: ApiKeyPublic }
interface Listed { keys: Array<ApiKeyPublic & { mine: boolean }> }
interface Res<T> { status: number; body: T; headers: Headers }
type Call = <T = ErrorBody>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Res<T>>;

function client(): { call: Call; cookie: () => string } {
  let cookie = '';
  const call: Call = async <T,>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', connection: 'close', ...(cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T, headers: res.headers };
  };
  return { call, cookie: () => cookie };
}
const cli = client().call; // never logs in: the CLI has no credential until the flow ends
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const start = async (label?: string): Promise<Started> => (await cli<Started>('POST', `${CL}/start`, label === undefined ? {} : { label })).body;
const poll = (deviceCode: unknown): Promise<Res<CliLoginPoll & ErrorBody>> => cli<CliLoginPoll & ErrorBody>('POST', `${CL}/poll`, { deviceCode });
function approved(r: Res<CliLoginPoll & ErrorBody>): { token: string; key: ApiKeyPublic } {
  if (r.body.status !== 'approved') throw new Error(`expected an approved poll, got ${JSON.stringify(r.body)}`);
  return { token: r.body.token, key: r.body.key };
}

async function person(tag: string): Promise<{ call: Call; userId: string; tenant: string }> {
  const { call } = client();
  const login = await call<Login>('POST', `${H}/test/login`, { email: `${tag}-${Date.now()}@a.test` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const me = await call('GET', `${H}/developer-keys`);
  expect(me.status).toBe(200);
  return { call, userId: login.body.user.userId, tenant: login.body.tenantId ?? login.body.user.personalTenant ?? '' };
}

describe('ADR 0799 — the CLI signs in by a code the person types', () => {
  it('start needs no credential and returns a secret device code, a typeable user code, and a link WITHOUT the code', async () => {
    const r = await cli<Started>('POST', `${CL}/start`, { label: 'laptop' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.deviceCode).toMatch(/^owcl_/);
    expect(r.body.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    expect(r.body.verificationPath).toBe('/access?tab=api-keys');
    expect(JSON.stringify(r.body.verificationPath)).not.toContain(r.body.userCode);
    expect((await poll(r.body.deviceCode)).body).toEqual({ status: 'pending', interval: 3 });
  });

  it('approve → the key is delivered ONCE, works for the protocol and the workspace, and is the approver’s own', async () => {
    const p = await person('approver');
    const s = await start('laptop');
    const shown = await p.call<Shown>('GET', `${CL}/requests/${s.userCode}`);
    expect(shown.status).toBe(200);
    expect(shown.body.request).toMatchObject({ userCode: s.userCode, label: 'laptop' });
    expect(JSON.stringify(shown.body)).not.toContain(s.deviceCode);
    // Typed loosely (lower case, no dash): the same code.
    expect((await p.call('POST', `${CL}/requests/${s.userCode.toLowerCase().replace('-', '')}/approve`, {})).status).toBe(204);

    const got = await poll(s.deviceCode);
    expect(got.status).toBe(200);
    expect(got.headers.get('cache-control')).toBe('no-store');
    const { token, key } = approved(got);
    expect(token).toMatch(/^owk_/);
    expect((await poll(s.deviceCode)).status, 'collected once').toBe(404);

    expect((await cli('GET', '/runs', undefined, bearer(token))).status).toBe(200);
    expect((await cli('GET', `${H}/roster`, undefined, bearer(token))).status).toBe(200);

    const listed = (await p.call<Listed>('GET', `${H}/developer-keys`)).body.keys.find((k) => k.keyId === key.keyId);
    expect(listed).toMatchObject({ name: 'CLI: laptop', mine: true });
    const left = Date.parse(listed?.expiresAt ?? '') - Date.now();
    expect(left).toBeGreaterThan(29 * DAY);
    expect(left).toBeLessThanOrEqual(30 * DAY);
    expect((await listChain(key.tenantId)).some((e) => e.kind === 'apikey.created' && (e.payload as { via?: string; keyId?: string }).via === 'cli-login' && (e.payload as { keyId?: string }).keyId === key.keyId)).toBe(true);
  });

  it('two polls racing get ONE key between them', async () => {
    const p = await person('race');
    const s = await start();
    expect((await p.call('POST', `${CL}/requests/${s.userCode}/approve`, {})).status).toBe(204);
    // Force the race: the first poll is HELD on its read of the request row
    // until the second has read it too, so both see `approved` and both reach
    // the claim. Only the compare-and-swap can then let exactly one through.
    const loginId = hashToken(s.deviceCode);
    const realGet = DurableCollection.prototype.get;
    let arrivals = 0;
    let release: () => void = () => undefined;
    const bothArrived = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      if (id === loginId) {
        arrivals += 1;
        if (arrivals >= 2) release();
        else await Promise.race([bothArrived, new Promise<void>((r) => setTimeout(r, 2000))]);
      }
      return realGet.call(this, id);
    });
    try {
      const [a, b] = await Promise.all([poll(s.deviceCode), poll(s.deviceCode)]);
      expect(arrivals, 'both polls read the approved row before either claimed it').toBe(2);
      expect([a, b].filter((r) => r.status === 200 && r.body.status === 'approved').length).toBe(1);
      expect([a, b].filter((r) => r.status === 404).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('deny → the CLI is told, and no key exists', async () => {
    const p = await person('denier');
    const s = await start('someone-elses');
    expect((await p.call('POST', `${CL}/requests/${s.userCode}/deny`, {})).status).toBe(204);
    expect((await poll(s.deviceCode)).body).toEqual({ status: 'denied' });
    expect((await p.call<Listed>('GET', `${H}/developer-keys`)).body.keys.some((k) => k.name === 'CLI: someone-elses')).toBe(false);
    // Decided once: it cannot be approved afterwards.
    expect((await p.call('POST', `${CL}/requests/${s.userCode}/approve`, {})).status).toBe(404);
  });
});

describe('ADR 0827 — the approval link is absolute, on the WEB origin', () => {
  it('verificationUri is OPENWOP_PUBLIC_BASE_URL origin + verificationPath, never carries the code, and is omitted when unset or not http(s)', async () => {
    const prior = process.env.OPENWOP_PUBLIC_BASE_URL;
    try {
      delete process.env.OPENWOP_PUBLIC_BASE_URL;
      const none = await cli<Started>('POST', `${CL}/start`, {});
      expect(none.status).toBe(201);
      expect(none.body.verificationUri).toBeUndefined();
      expect(none.body.verificationPath).toBe('/access?tab=api-keys');

      // A protocol-origin CLI (api.<host>) must be sent to the SPA origin, and
      // only the origin of the configured URL counts (no path smuggling).
      process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.test/some/path/';
      const set = await start();
      expect(set.verificationUri).toBe('https://app.example.test/access?tab=api-keys');
      expect(set.verificationUri).not.toContain(set.userCode);

      process.env.OPENWOP_PUBLIC_BASE_URL = 'javascript:alert(1)';
      expect((await start()).verificationUri).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL; else process.env.OPENWOP_PUBLIC_BASE_URL = prior;
    }
  });
});

describe('ADR 0799 — who may approve', () => {
  it('nobody without a signed-in person: no credential, an anonymous session, and a key are all refused', async () => {
    const s = await start();
    // Each refusal is the route's own person check (its message), not an
    // earlier 401 from the auth layer.
    const bare = await client().call('POST', `${CL}/requests/${s.userCode}/approve`, {});
    expect(bare.status).toBe(401);
    expect(bare.body.message).toBe(NOT_A_PERSON);
    // An anonymous session: the cookie the demo mints for a caller who never signed in.
    const anon = client();
    await anon.call('GET', `${H}/developer-keys`);
    expect(anon.cookie(), 'the demo minted an anonymous session cookie').toMatch(/^__session=/);
    const anonTry = await anon.call('POST', `${CL}/requests/${s.userCode}/approve`, {});
    expect(anonTry.status).toBe(401);
    expect(anonTry.body.message).toBe(NOT_A_PERSON);
    const p = await person('keyholder');
    const key = (await p.call<Minted>('POST', `${H}/developer-keys`, { name: 'k', scopes: ['*'] })).body.token;
    for (const r of [
      await cli('POST', `${CL}/requests/${s.userCode}/approve`, {}, bearer(key)),
      await cli('GET', `${CL}/requests/${s.userCode}`, undefined, bearer(key)),
    ]) {
      expect(r.status).toBe(401);
      expect(r.body.message).toBe(NOT_A_PERSON);
    }
    expect((await poll(s.deviceCode)).body.status, 'still pending').toBe('pending');
  });

  it('an unknown or malformed code is a uniform 404, for looking and for deciding', async () => {
    const p = await person('guesser');
    for (const code of ['ZZZZ-ZZZZ', 'nope', '../x']) {
      expect((await p.call('GET', `${CL}/requests/${encodeURIComponent(code)}`)).status, code).toBe(404);
      expect((await p.call('POST', `${CL}/requests/${encodeURIComponent(code)}/approve`, {})).status, code).toBe(404);
    }
    expect((await poll('owcl_not-a-real-one')).status).toBe(404);
    expect((await poll(42)).status).toBe(404);
  });

  it('a workspace with keys turned off cannot approve one', async () => {
    const p = await person('off');
    const mine = (await p.call<Minted>('POST', `${H}/developer-keys`, { name: 'find-tenant', scopes: ['runs:read'] })).body.key.tenantId;
    await setTenantKeyPolicy(mine, { disabled: true }, 'test');
    invalidateTenantKeyPolicyCache();
    try {
      const s = await start();
      const r = await p.call('POST', `${CL}/requests/${s.userCode}/approve`, {});
      expect(r.status).toBe(403);
      expect(r.body.details?.code).toBe('keys_disabled');
    } finally {
      await setTenantKeyPolicy(mine, { disabled: false }, 'test');
      invalidateTenantKeyPolicyCache();
    }
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
    const other = (await p.call<Minted>('POST', `${H}/developer-keys`, { name: 'other', scopes: ['runs:read'] })).body;
    const s = await start('to-sign-out');
    await p.call('POST', `${CL}/requests/${s.userCode}/approve`, {});
    const { token } = approved(await poll(s.deviceCode));
    expect((await cli('POST', `${CL}/logout`, {}, bearer(token))).status).toBe(204);
    expect((await cli('GET', '/runs', undefined, bearer(token))).status).toBe(401);
    expect((await cli('GET', '/runs', undefined, bearer(other.token))).status).toBe(200);
  });

  it('a narrow key can sign itself out too; a session cannot use the route; a key still cannot manage OTHER keys', async () => {
    const p = await person('narrow');
    const narrow = (await p.call<Minted>('POST', `${H}/developer-keys`, { name: 'narrow', scopes: ['runs:read'] })).body;
    const victim = (await p.call<Minted>('POST', `${H}/developer-keys`, { name: 'victim', scopes: ['runs:read'] })).body;
    expect((await cli('DELETE', `${H}/developer-keys/${encodeURIComponent(victim.key.keyId)}`, undefined, bearer(narrow.token))).status).toBe(403);
    expect((await p.call('POST', `${CL}/logout`, {})).status).toBe(400);
    expect((await cli('POST', `${CL}/logout`, {}, bearer(narrow.token))).status).toBe(204);
    expect((await cli('GET', '/runs', undefined, bearer(narrow.token))).status).toBe(401);
    const tenant = narrow.key.tenantId;
    const live = (await listApiKeys(tenant, { callerSubject: 'x', isAdmin: true })).filter((k) => !k.revokedAt).map((k) => k.name);
    expect(live).toContain('victim');
    expect(live).not.toContain('narrow');
  });
});
