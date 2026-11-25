/**
 * ADR 1160 P1 (D2) — a canvas is read and written only in its own org.
 *
 * Real app, real sign-ins: one tenant, orgs A and B. An editor of B only, an
 * editor of A only, and the tenant owner (in both). A slides deck created through
 * A's path is stamped org A (P0), then:
 *  1. B's editor cannot reach it through B's paths: editor GET, PATCH and DELETE,
 *     Documents' canvas list and Documents' delete all answer as if it did not
 *     exist (404, or absent from the list);
 *  2. A's editor can, through A's paths;
 *  3. the owner, a member of BOTH, still gets 404 through B's path (the path org
 *     must be the canvas's org) and reaches it through A's;
 *  4. the shared predicate decides in the canvas's org whatever the lane: B's
 *     editor gets null from `getCanvasForCaller`, A's gets the canvas;
 *  5. a tenant-shared canvas (no org, every canvas before ADR 1160) is unchanged:
 *     B's editor reaches it through B's path;
 *  6. a run with no person keeps its reach only when it says so
 *     (`orgSystemLane`); an omitted subject is refused on an org-bound canvas.
 *
 * Sabotage notes: making `canvasOrgAllowed` return true reds 1 and 4; dropping
 * the path-org match in `loadCanvas` reds 3; dropping the `{ orgId }` filter
 * from Documents' list reds the owner's list case in 3; returning true for an
 * omitted subject reds 6.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { canvasReadAllowed, createCanvasForTenant, getCanvasForCaller, getCanvasForTenant } from '../src/host/canvasSurface.js';

let BASE: string;
let server: http.Server;
let n = 0;

interface Res<T> { status: number; body: T }
interface Client { get<T>(p: string): Promise<Res<T>>; post<T>(p: string, b?: unknown): Promise<Res<T>>; patch<T>(p: string, b?: unknown): Promise<Res<T>>; del<T>(p: string): Promise<Res<T>> }
function client(): Client {
  let cookie = '';
  async function call<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `c1160-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}
const SL = (org: string, suffix = ''): string => `/host/openwop-app/slides/orgs/${encodeURIComponent(org)}/canvases${suffix}`;
const DOC = (org: string, suffix: string): string => `/host/openwop-app/documents/orgs/${encodeURIComponent(org)}${suffix}`;

let tenantId: string;
let orgA: string; let orgB: string;
let owner: Client; let edA: Client; let edB: Client;
let edAId: string; let edBId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['slides', 'documents']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  tenantId = `org:c1160-${Date.now()}`;
  owner = client(); await signup(owner, tenantId);
  edA = client(); edAId = await signup(edA, tenantId);
  edB = client(); edBId = await signup(edB, tenantId);
  orgA = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Workspace A' })).body.orgId;
  orgB = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Workspace B' })).body.orgId;
  await owner.post(`/host/openwop-app/test/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'A', subject: edAId, roles: ['editor'] });
  await owner.post(`/host/openwop-app/test/orgs/${encodeURIComponent(orgB)}/members`, { displayName: 'B', subject: edBId, roles: ['editor'] });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function deckInA(): Promise<string> {
  const r = await owner.post<{ canvasId: string; orgId?: string }>(SL(orgA), { name: `Deck ${n++}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.orgId, 'fixture: P0 stamps the path org').toBe(orgA);
  return r.body.canvasId;
}
const listed = async (c: Client, org: string, id: string): Promise<boolean> =>
  ((await c.get<{ canvases: Array<{ canvasId: string }> }>(DOC(org, '/canvas-sources'))).body.canvases ?? []).some((x) => x.canvasId === id);

describe('ADR 1160 P1 — a canvas is reached only in its own org', () => {
  it('1. B’s editor cannot reach an org-A deck through any of B’s paths', async () => {
    const id = await deckInA();
    expect((await edB.get(SL(orgB, `/${id}`))).status).toBe(404);
    expect((await edB.patch(SL(orgB, `/${id}`), { state: { title: 'x', slides: [] } })).status).toBe(404);
    expect(await listed(edB, orgB, id)).toBe(false);
    expect((await edB.del(DOC(orgB, `/canvases/${id}`))).status).toBe(404);
    expect((await edB.del(SL(orgB, `/${id}`))).status).toBe(404);
    expect(await getCanvasForTenant(tenantId, id), 'nothing was deleted').not.toBeNull();
  });

  it('2. A’s editor reaches it through A’s paths', async () => {
    const id = await deckInA();
    expect((await edA.get(SL(orgA, `/${id}`))).status).toBe(200);
    expect(await listed(edA, orgA, id)).toBe(true);
  });

  it('3. a member of both orgs still needs the canvas’s own path', async () => {
    const id = await deckInA();
    expect((await owner.get(SL(orgB, `/${id}`))).status).toBe(404);
    expect(await listed(owner, orgB, id)).toBe(false);
    expect((await owner.get(SL(orgA, `/${id}`))).status).toBe(200);
    expect(await listed(owner, orgA, id)).toBe(true);
  });

  it('4. the shared predicate decides in the canvas’s org, whatever the lane', async () => {
    const id = await deckInA();
    expect(await getCanvasForCaller(tenantId, id, { subject: edBId })).toBeNull();
    expect((await getCanvasForCaller(tenantId, id, { subject: edAId }))?.canvasId).toBe(id);
  });

  it('5. a tenant-shared canvas (no org) is unchanged', async () => {
    const shared = await createCanvasForTenant(tenantId, {
      canvasTypeId: 'canvas.slides', orgId: null, orgWhy: 'system:test-legacy',
      initialState: { title: 'Legacy', slides: [{ id: 's1', name: 'S', layout: 'title', title: 'Legacy' }] },
    });
    expect((await edB.get(SL(orgB, `/${shared.canvasId}`))).status).toBe(200);
    expect(await listed(edB, orgB, shared.canvasId)).toBe(true);
  });

  it('6. a lane with no person keeps its reach only when it says so', async () => {
    const id = await deckInA();
    const c = (await getCanvasForTenant(tenantId, id))!;
    expect(await canvasReadAllowed(tenantId, c, {}), 'an omitted subject is refused').toBe(false);
    expect(await canvasReadAllowed(tenantId, c, { orgSystemLane: 'system:test' })).toBe(true);
  });
});
