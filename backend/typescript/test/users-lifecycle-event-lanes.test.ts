/**
 * ADR 0617 D1 — the WIRING witness (the mechanism-vs-wiring lesson): over the
 * REAL app, a workflow bound to `host.users.user.deactivated` is started
 * exactly ONCE by each of the three deactivation lanes, with the ids-only
 * payload, and NOT started again by a repeat of the same deactivation:
 *
 *   (A) the RFC 0050/0159 conformance seam — `deactivate-user` by externalId;
 *   (B) the real `/scim/v2/Users/:id` PATCH `active:false` (bearer-authed);
 *   (C) the admin Disable route (`reason: 'admin'`);
 *   (D) the admin erase route → `host.users.user.erased` (after `deleteUser`).
 *
 * Runs are observed on the run store by `metadata.hostEvent.bindingId` (the
 * `cms-host-event-binding.test.ts` shape). Each lane's repeat is asserted to
 * leave the count UNCHANGED — the D5 compensation (an IdP retry) must never
 * start a second offboarding run.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { createHostEventBinding } from '../src/host/hostEventDispatcher.js';
import { getUser } from '../src/features/users/usersService.js';

const SCIM_TENANT = 'scim-lanes';
const SCIM_BEARER = 'scim-lanes-bearer-0123456789abcdef';
const DEACTIVATED = 'host.users.user.deactivated';
const ERASED = 'host.users.user.erased';

let BASE: string;
let server: http.Server;
let app: Express;
let storage: Storage;
let workflowId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SCIM_URL = 'http://scim.invalid/scim/v2'; // the seam is reachable (never fetched)
  process.env.OPENWOP_SCIM_BEARER = SCIM_BEARER; // `/scim/v2/*` exists; the seam honours it too
  process.env.OPENWOP_SCIM_TENANT = SCIM_TENANT;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const wellKnown = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
  workflowId = wellKnown.fixtures?.[0] ?? 'openwop-app.uppercase';
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const k of ['OPENWOP_TEST_SCIM_URL', 'OPENWOP_SCIM_BEARER', 'OPENWOP_SCIM_TENANT', 'OPENWOP_TEST_AUTH_ENABLED']) delete process.env[k];
});

interface Res<T = any> { status: number; body: T }
async function call(method: string, path: string, opts: { body?: unknown; bearer?: string; cookie?: string } = {}): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  return { status: res.status, body: out };
}

/** Runs started by ONE binding, with their trigger payloads. Polls until the
 *  count reaches `atLeast` or the budget lapses (fire-and-forget emit). */
async function runsOf(tenantId: string, bindingId: string, atLeast: number): Promise<Array<{ run: RunRecord; payload: Record<string, unknown>; eventName: string }>> {
  let found: RunRecord[] = [];
  for (let i = 0; i < 60; i++) {
    const runs = await storage.listRuns({ tenantId, limit: 100 });
    found = runs.filter((r) => (r.metadata as { hostEvent?: { bindingId?: string } } | undefined)?.hostEvent?.bindingId === bindingId);
    if (found.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return found.map((run) => {
    const td = (run.metadata as { triggerData?: { eventName: string; payload: Record<string, unknown> } }).triggerData!;
    return { run, payload: td.payload, eventName: td.eventName };
  });
}
/** A settle window long enough for a fanout that WOULD have started a run. */
const settle = () => new Promise((r) => setTimeout(r, 150));

/** A signed-in session cookie from the test seam. */
async function loginCookie(subject: string): Promise<string> {
  const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, displayName: subject }),
  });
  expect(login.status).toBe(201);
  return (getSetCookies(login.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
}

describe('lane A — the conformance seam (deactivate-user by externalId)', () => {
  it('starts the bound workflow exactly once with {userId, tenantId, source:scim, reason:scim}; the retry starts nothing', async () => {
    const binding = await createHostEventBinding({ tenantId: SCIM_TENANT, eventType: DEACTIVATED, workflowId, createdBy: 'test' });
    // The seam sits BEHIND the global auth middleware (not a public prefix), which
    // refuses a foreign bearer unless a healthy session cookie rides along — so
    // present both: the cookie satisfies the middleware, the SCIM bearer satisfies
    // the seam's own `requireScimBearer` (configured in this app).
    const cookie = await loginCookie('oidc:lane-a-driver');
    const provision = await call('POST', '/v1/host/openwop-app/auth/scim/provision', {
      bearer: SCIM_BEARER, cookie, body: { scimUrl: 'x', op: 'create-user', externalId: 'ext-lane-a', userName: 'lane.a@acme.test' },
    });
    expect(provision.status, JSON.stringify(provision.body)).toBe(201);
    const userId = provision.body.principal.userId as string;

    const deactivate = await call('POST', '/v1/host/openwop-app/auth/scim/provision', {
      bearer: SCIM_BEARER, cookie, body: { scimUrl: 'x', op: 'deactivate-user', externalId: 'ext-lane-a' },
    });
    expect(deactivate.status, JSON.stringify(deactivate.body)).toBe(200);

    const runs = await runsOf(SCIM_TENANT, binding.bindingId, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.run.workflowId).toBe(workflowId);
    expect(runs[0]!.eventName).toBe(DEACTIVATED);
    expect(Object.keys(runs[0]!.payload).sort()).toEqual(['reason', 'source', 'tenantId', 'userId']);
    expect(runs[0]!.payload).toEqual({ userId, tenantId: SCIM_TENANT, source: 'scim', reason: 'scim' });
    // An event-started run is a SYSTEM run: no acting user is stamped (ADR 0617 open question, resolved).
    expect((runs[0]!.run.metadata as { actingUserId?: string }).actingUserId).toBeUndefined();

    // The IdP retry (D5 compensation) — already disabled, no second run.
    const again = await call('POST', '/v1/host/openwop-app/auth/scim/provision', {
      bearer: SCIM_BEARER, cookie, body: { scimUrl: 'x', op: 'deactivate-user', externalId: 'ext-lane-a' },
    });
    expect(again.status).toBe(200);
    await settle();
    expect(await runsOf(SCIM_TENANT, binding.bindingId, 2)).toHaveLength(1);
  });
});

describe('lane B — the real /scim/v2 PATCH active:false', () => {
  it('starts the bound workflow exactly once; PATCH again (and DELETE) start nothing', async () => {
    const binding = await createHostEventBinding({ tenantId: SCIM_TENANT, eventType: DEACTIVATED, workflowId, createdBy: 'test' });
    const created = await call('POST', '/scim/v2/Users', { bearer: SCIM_BEARER, body: { userName: 'lane.b@acme.test', externalId: 'ext-lane-b' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;

    const patch = await call('PATCH', `/scim/v2/Users/${encodeURIComponent(id)}`, {
      bearer: SCIM_BEARER, body: { Operations: [{ op: 'replace', path: 'active', value: false }] },
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.active).toBe(false);

    const runs = await runsOf(SCIM_TENANT, binding.bindingId, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.payload).toEqual({ userId: id, tenantId: SCIM_TENANT, source: 'scim', reason: 'scim' });

    expect((await call('PATCH', `/scim/v2/Users/${encodeURIComponent(id)}`, { bearer: SCIM_BEARER, body: { active: false } })).status).toBe(200);
    expect((await call('DELETE', `/scim/v2/Users/${encodeURIComponent(id)}`, { bearer: SCIM_BEARER })).status).toBe(200);
    await settle();
    expect(await runsOf(SCIM_TENANT, binding.bindingId, 2)).toHaveLength(1);
  });
});

describe('lanes C + D — admin Disable and admin erase over HTTP', () => {
  it('Disable starts the bound workflow once with reason:admin; a repeat Disable starts nothing; erase fires host.users.user.erased once', async () => {
    // Personal `user:` tenant — the caller is its implicit owner (a single-human tenant by construction).
    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'oidc:lane-c-admin', displayName: 'Lane C Admin' }),
    });
    expect(login.status).toBe(201);
    const cookie = (getSetCookies(login.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
    const me = await call('GET', '/v1/host/openwop-app/users/me', { cookie });
    expect(me.status).toBe(200);
    const tenantId = me.body.tenantId as string;
    expect(tenantId.startsWith('user:')).toBe(true);

    const bDeact = await createHostEventBinding({ tenantId, eventType: DEACTIVATED, workflowId, createdBy: 'test' });
    const bErased = await createHostEventBinding({ tenantId, eventType: ERASED, workflowId, createdBy: 'test' });

    const target = await call('POST', '/v1/host/openwop-app/users/users', { cookie, body: { principalId: 'oidc:lane-c-target', email: 'target@acme.test' } });
    expect(target.status, JSON.stringify(target.body)).toBe(201);
    const userId = target.body.userId as string;

    const disable = await call('POST', `/v1/host/openwop-app/users/users/${encodeURIComponent(userId)}/disable`, { cookie });
    expect(disable.status, JSON.stringify(disable.body)).toBe(200);
    const runs = await runsOf(tenantId, bDeact.bindingId, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.payload).toEqual({ userId, tenantId, source: 'manual', reason: 'admin' });

    expect((await call('POST', `/v1/host/openwop-app/users/users/${encodeURIComponent(userId)}/disable`, { cookie })).status).toBe(200);
    await settle();
    expect(await runsOf(tenantId, bDeact.bindingId, 2)).toHaveLength(1);

    // Lane D — erase. Fires ONLY after `deleteUser` succeeded.
    const del = await call('DELETE', `/v1/host/openwop-app/users/users/${encodeURIComponent(userId)}`, { cookie });
    expect(del.status).toBe(204);
    expect(await getUser(userId)).toBeNull();
    const erased = await runsOf(tenantId, bErased.bindingId, 1);
    expect(erased).toHaveLength(1);
    expect(Object.keys(erased[0]!.payload).sort()).toEqual(['outcome', 'tenantId', 'userId']);
    expect(erased[0]!.payload).toEqual({ userId, tenantId, outcome: 'deleted' });
    // A second DELETE 404s and emits nothing.
    expect((await call('DELETE', `/v1/host/openwop-app/users/users/${encodeURIComponent(userId)}`, { cookie })).status).toBe(404);
    await settle();
    expect(await runsOf(tenantId, bErased.bindingId, 2)).toHaveLength(1);
  });
});
