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
 *
 * NEGATIVE BARRIER. "The repeat started nothing" is not proven by sleeping: after
 * each repeat a SENTINEL (the same lane acting on a different user) is driven,
 * and the test waits for the sentinel's run. The binding then must hold EXACTLY
 * the original run and the sentinel's — a run the repeat wrongly started was
 * emitted earlier than the sentinel's and shows up as a duplicate of the
 * original `userId`. Residual ceiling: the run store is polled (25 ms, bounded)
 * for a positive condition; this file drives real runs through `createApp`.
 *
 * Sabotage that turns it red: `usersService.ts` disable mutate's
 * `changed = row.status !== status` → `changed = true` (every repeat lane);
 * `emit.ts` deactivated payload gaining a key (lanes A–C payload pins);
 * `features/users/routes.ts` Disable passing `reason: 'scim'` (lane C only —
 * the service-level test passes the reason itself); the route's
 * `userErased(…)` call removed (lane D); `routes/authScim.ts` PATCH ignoring
 * `active` (lane B).
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
  for (const k of ['OPENWOP_TEST_SCIM_URL', 'OPENWOP_SCIM_BEARER', 'OPENWOP_SCIM_TENANT', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET']) delete process.env[k];
});

/** The JSON bodies this file reads: flat ids, plus the seam's `principal`. */
interface Body { [k: string]: unknown; principal?: { userId: string } }
interface Res { status: number; body: Body }
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
  const out: unknown = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, body: (out ?? {}) as Body };
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
/** The barrier: wait for the SENTINEL's run, then the binding must hold exactly
 *  `expected` userIds (order-free) — a duplicate means a repeat started a run. */
async function expectExactlyRunsFor(tenantId: string, bindingId: string, expected: string[]): Promise<void> {
  const runs = await runsOf(tenantId, bindingId, expected.length);
  expect(runs.map((r) => r.payload.userId as string).sort()).toEqual([...expected].sort());
}

/** A signed-in session cookie from the test seam. */
async function loginCookie(subject: string): Promise<string> {
  const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
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
    const provision = await call('POST', '/host/openwop-app/auth/scim/provision', {
      bearer: SCIM_BEARER, cookie, body: { scimUrl: 'x', op: 'create-user', externalId: 'ext-lane-a', userName: 'lane.a@acme.test' },
    });
    expect(provision.status, JSON.stringify(provision.body)).toBe(201);
    const userId = provision.body.principal!.userId;

    const deactivate = await call('POST', '/host/openwop-app/auth/scim/provision', {
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
    const again = await call('POST', '/host/openwop-app/auth/scim/provision', {
      bearer: SCIM_BEARER, cookie, body: { scimUrl: 'x', op: 'deactivate-user', externalId: 'ext-lane-a' },
    });
    expect(again.status).toBe(200);
    // Sentinel: the same lane on a different user.
    const s1 = await call('POST', '/host/openwop-app/auth/scim/provision', {
      bearer: SCIM_BEARER, cookie, body: { scimUrl: 'x', op: 'create-user', externalId: 'ext-lane-a-sentinel', userName: 'lane.a.s@acme.test' },
    });
    expect(s1.status).toBe(201);
    expect((await call('POST', '/host/openwop-app/auth/scim/provision', {
      bearer: SCIM_BEARER, cookie, body: { scimUrl: 'x', op: 'deactivate-user', externalId: 'ext-lane-a-sentinel' },
    })).status).toBe(200);
    await expectExactlyRunsFor(SCIM_TENANT, binding.bindingId, [userId, s1.body.principal!.userId]);
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
    // Sentinel: the same PATCH lane on a different user.
    const s = await call('POST', '/scim/v2/Users', { bearer: SCIM_BEARER, body: { userName: 'lane.b.s@acme.test', externalId: 'ext-lane-b-sentinel' } });
    expect(s.status).toBe(201);
    const sid = s.body.id as string;
    expect((await call('PATCH', `/scim/v2/Users/${encodeURIComponent(sid)}`, { bearer: SCIM_BEARER, body: { active: false } })).status).toBe(200);
    await expectExactlyRunsFor(SCIM_TENANT, binding.bindingId, [id, sid]);
  });
});

describe('lanes C + D — admin Disable and admin erase over HTTP', () => {
  it('Disable starts the bound workflow once with reason:admin; a repeat Disable starts nothing; erase fires host.users.user.erased once', async () => {
    // Personal `user:` tenant — the caller is its implicit owner (a single-human tenant by construction).
    const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'oidc:lane-c-admin', displayName: 'Lane C Admin' }),
    });
    expect(login.status).toBe(201);
    const cookie = (getSetCookies(login.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
    const me = await call('GET', '/host/openwop-app/users/me', { cookie });
    expect(me.status).toBe(200);
    const tenantId = me.body.tenantId as string;
    expect(tenantId.startsWith('user:')).toBe(true);

    const bDeact = await createHostEventBinding({ tenantId, eventType: DEACTIVATED, workflowId, createdBy: 'test' });
    const bErased = await createHostEventBinding({ tenantId, eventType: ERASED, workflowId, createdBy: 'test' });

    const target = await call('POST', '/host/openwop-app/users/users', { cookie, body: { principalId: 'oidc:lane-c-target', email: 'target@acme.test' } });
    expect(target.status, JSON.stringify(target.body)).toBe(201);
    const userId = target.body.userId as string;

    const disable = await call('POST', `/host/openwop-app/users/users/${encodeURIComponent(userId)}/disable`, { cookie });
    expect(disable.status, JSON.stringify(disable.body)).toBe(200);
    const runs = await runsOf(tenantId, bDeact.bindingId, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.payload).toEqual({ userId, tenantId, source: 'manual', reason: 'admin' });

    expect((await call('POST', `/host/openwop-app/users/users/${encodeURIComponent(userId)}/disable`, { cookie })).status).toBe(200);
    // Sentinel: Disable a second target.
    const t2 = await call('POST', '/host/openwop-app/users/users', { cookie, body: { principalId: 'oidc:lane-c-sentinel' } });
    expect(t2.status).toBe(201);
    const sentinelId = t2.body.userId as string;
    expect((await call('POST', `/host/openwop-app/users/users/${encodeURIComponent(sentinelId)}/disable`, { cookie })).status).toBe(200);
    await expectExactlyRunsFor(tenantId, bDeact.bindingId, [userId, sentinelId]);

    // Lane D — erase. Fires ONLY after `deleteUser` succeeded.
    const del = await call('DELETE', `/host/openwop-app/users/users/${encodeURIComponent(userId)}`, { cookie });
    expect(del.status).toBe(204);
    expect(await getUser(userId)).toBeNull();
    const erased = await runsOf(tenantId, bErased.bindingId, 1);
    expect(erased).toHaveLength(1);
    expect(Object.keys(erased[0]!.payload).sort()).toEqual(['outcome', 'tenantId', 'userId']);
    expect(erased[0]!.payload).toEqual({ userId, tenantId, outcome: 'deleted' });
    // A second DELETE 404s and emits nothing.
    expect((await call('DELETE', `/host/openwop-app/users/users/${encodeURIComponent(userId)}`, { cookie })).status).toBe(404);
    // Sentinel: erase the second target.
    expect((await call('DELETE', `/host/openwop-app/users/users/${encodeURIComponent(sentinelId)}`, { cookie })).status).toBe(204);
    await expectExactlyRunsFor(tenantId, bErased.bindingId, [userId, sentinelId]);
  });
});
