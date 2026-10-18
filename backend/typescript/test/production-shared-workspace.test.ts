/**
 * GC-5 / ADR 0508 — the production (Vendor Directory + plans) org-scoped routes must
 * act in the tenant the gate AUTHORIZED (the ACTIVE workspace tenant), not the
 * caller's HOME tenant. `authorizeOrgScope` authorizes against the active `ws:`
 * workspace and returns it as `ctx.tenantId`; the 14 handler sites used to read
 * `ctx.user.tenantId` (HOME), so inside a shared workspace a vendor was filed under
 * the member's own private partition — invisible to the org and mis-tenanted (every
 * member held a private, invisible copy of the org's vendor directory).
 *
 * Non-vacuity: the whole production path — sign in (no tenantId override, so each
 * caller lands in their own `user:` personal tenant), create a real `ws:` workspace,
 * switch into it (active !== personal), invite a SECOND human and have them accept.
 * `listVendors(tenantId, orgId, …)` filters by BOTH, so the boundary is proven by the
 * A-writes / B-reads split: member A creates a vendor, member B lists it. Before the
 * fix A filed under HOME-A and B read HOME-B, so B's list was empty no matter what A
 * wrote. A single-caller list would be vacuous (A writes and reads the same HOME
 * partition). No demo bypass, so HOME is genuinely distinct from ACTIVE. Born-red:
 * revert a site to `ctx.user.tenantId` → B stops seeing A's vendor.
 *
 * w32 (grade-tests): the case witnessed only the CREATE and LIST sites of the
 * fourteen; it now also drives GET-one, PATCH and the plans list as member B.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { savePlan } from '../src/features/production/productionService.js';

let BASE = '';
let server: http.Server;
let n = 0;

/** The response fields this file reads — no `any`. */
interface Body {
  workspaceId?: string;
  token?: string;
  vendorId?: string;
  name?: string;
  notes?: string;
  vendors?: Array<{ vendorId: string }>;
  plans?: Array<{ planId: string }>;
}
interface Res { status: number; body: Body }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
type Client = ReturnType<typeof client>;

async function signIn(c: Client, email: string): Promise<void> {
  const r = await c.post('/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

/** A REAL `ws:` shared workspace, created + switched into through the routes — the
 *  switch is what makes active !== personal. The workspace root is itself an org. */
async function sharedWorkspace(c: Client): Promise<string> {
  const ws = await c.post('/host/openwop-app/workspaces', { name: `Prod WS ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  expect(ws.body.workspaceId, 'must be a real shared workspace').toMatch(/^ws:/);
  const sw = await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws.body.workspaceId!)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return ws.body.workspaceId!;
}

/** Invite a second human into the workspace root org and have them accept — the real
 *  two-member path (the workspace root IS an org, orgId === tenantId === ws). */
async function joinAsMember(owner: Client, ws: string, joiner: Client, email: string, role: string): Promise<void> {
  const invite = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/invites`, { email, role });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  expect(invite.body.token, 'the dev/test invite path must expose the token').toBeTruthy();
  await signIn(joiner, email);
  const accepted = await joiner.post('/host/openwop-app/orgs/invitations/accept', { token: invite.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  const sw = await joiner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
}

const vendorsPath = (orgId: string): string =>
  `/host/openwop-app/production/orgs/${encodeURIComponent(orgId)}/vendors`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE; // the de-facto-owner bypass would make gates vacuous
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'production']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('GC-5 — production routes act in the tenant the gate authorized', () => {
  it('member B SEES the vendor member A created in the shared workspace', async () => {
    const a = client();
    await signIn(a, `prod-owner-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);
    const b = client();
    await joinAsMember(a, ws, b, `prod-b-${n++}@acme.test`, 'editor');

    const created = await a.post(vendorsPath(ws), { name: 'Acme Fabrication', type: 'contractor' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.vendorId).toBeTruthy();

    const list = await b.get(vendorsPath(ws));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // Before the fix B read their OWN home-tenant partition, so this list was empty
    // no matter what A had written — every member held a private invisible copy.
    expect(
      (list.body.vendors ?? []).map((v) => v.vendorId),
      'member B must see the org vendor A created, not a private copy',
    ).toContain(created.body.vendorId);

    // GET-one and PATCH act in the same (active) tenant: B reads and edits A's vendor,
    // and A sees B's edit.
    const one = await b.get(`${vendorsPath(ws)}/${encodeURIComponent(created.body.vendorId!)}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.name).toBe('Acme Fabrication');
    const patched = await b.patch(`${vendorsPath(ws)}/${encodeURIComponent(created.body.vendorId!)}`, { notes: 'b was here' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((await a.get(`${vendorsPath(ws)}/${encodeURIComponent(created.body.vendorId!)}`)).body.notes).toBe('b was here');

    // Plans read in the workspace tenant too (a plan is generated into it by a run).
    await savePlan({ tenantId: ws, orgId: ws, planId: 'pln:gc5-shared', strategySummary: 'Shared plan', recommendations: [] });
    const plans = await b.get(`/host/openwop-app/production/orgs/${encodeURIComponent(ws)}/plans`);
    expect(plans.status, JSON.stringify(plans.body)).toBe(200);
    expect((plans.body.plans ?? []).map((pl) => pl.planId)).toEqual(['pln:gc5-shared']);
  });
});
