/**
 * ADR 0469 Phase B — the widget anon-grant editor's backend surface, ROUTE-level.
 *
 *  - the NEW workspace-scoped tool-catalog read (`GET …/tool-catalog`) returns the
 *    SSoT catalog to a `workspace:read` member — and is NOT superadmin-gated
 *    (finding 3: the operator editor must not couple to the superadmin route);
 *  - the grant SAVE stays `workspace:write` (the existing widget PATCH): a
 *    read-only member is denied; an editor persists the grant + write cap;
 *  - `cleanAnonGrant` enforces `writeControl` when write tools are present (OD1).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `wg-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:wg-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, tenantId);
  const member = client();
  const memberUser = await signup(member, tenantId);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}
const widgetsBase = (orgId: string): string => `/v1/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets`;
const catalogPath = (orgId: string): string => `/v1/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/tool-catalog`;

describe('ADR 0469 Phase B — widget grant editor routes', () => {
  it('the tool-catalog read is workspace-scoped (a viewer can read it — NOT superadmin-only)', async () => {
    const { member, orgId } = await ownerWithMember('viewer'); // viewer ⇒ workspace:read, no write
    const cat = await member.get(catalogPath(orgId));
    expect(cat.status).toBe(200);
    expect(Array.isArray(cat.body.tools)).toBe(true);
    expect(cat.body.tools.length).toBeGreaterThan(0);
    expect(cat.body.tools).toEqual([...cat.body.tools].sort()); // sorted SSoT
  });

  it('an unauthenticated caller cannot read the catalog', async () => {
    const anon = client();
    const cat = await anon.get(catalogPath('org-x'));
    expect(cat.status).toBeGreaterThanOrEqual(401);
    expect(cat.status).toBeLessThan(404);
  });

  it('a read-only member cannot SAVE a grant (workspace:write); an editor can, and it persists', async () => {
    const { owner, member, orgId } = await ownerWithMember('editor');
    const created = await owner.post(widgetsBase(orgId), { agentId: 'support', allowedDomains: ['acme.com'] });
    expect(created.status).toBe(201);
    const widgetId = created.body.widget.widgetId as string;

    // A read-only member (viewer) lacks workspace:write → the grant SAVE is denied by
    // requireOrgScope BEFORE the widget is even looked up.
    const { member: viewer, orgId: vOrg } = await ownerWithMember('viewer');
    const denied = await viewer.patch(`${widgetsBase(vOrg)}/any-widget`, { anonToolGrant: { read: ['openwop:knowledge.search'] } });
    expect(denied.status).toBe(403);

    // The editor saves a read+write grant with a write cap; writeControl is required
    // by cleanAnonGrant when write tools are present (OD1).
    const grant = { read: ['openwop:knowledge.search'], write: ['openwop:kanban.add-todo'], writeControl: 'hitl' as const };
    const saved = await member.patch(`${widgetsBase(orgId)}/${widgetId}`, { anonToolGrant: grant, caps: { maxWritesPerDay: 5 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const got = await member.get(`${widgetsBase(orgId)}/${widgetId}`);
    expect(got.body.widget.anonToolGrant.read).toEqual(['openwop:knowledge.search']);
    expect(got.body.widget.anonToolGrant.write).toEqual(['openwop:kanban.add-todo']);
    expect(got.body.widget.anonToolGrant.writeControl).toBe('hitl');
    expect(got.body.widget.caps.maxWritesPerDay).toBe(5);
  });

  it('a write grant WITHOUT a control is rejected (OD1 — no uncontrolled anon write)', async () => {
    const { owner, orgId } = await ownerWithMember('editor');
    const created = await owner.post(widgetsBase(orgId), { agentId: 'support', allowedDomains: ['acme.com'] });
    const widgetId = created.body.widget.widgetId as string;
    const bad = await owner.patch(`${widgetsBase(orgId)}/${widgetId}`, { anonToolGrant: { write: ['openwop:kanban.add-todo'] } });
    expect(bad.status).toBe(400);
  });
});
