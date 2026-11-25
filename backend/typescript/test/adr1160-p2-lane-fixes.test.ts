/**
 * ADR 1160 P2 (D3 "F" rows) — the lanes that bypassed or weakened THE canvas
 * predicate decide in the canvas's own org too.
 *
 * Real app, real sign-ins (as the P1 test): one tenant, orgs A and B, an editor
 * of each and the owner (in both). A slides deck made through A's path is
 * stamped org A. Then, for that deck:
 *  1. live collaboration: B's editor gets no ticket (404); A's editor does;
 *  2. a share link minted through B's path is 404, even for the owner; through A's, 201;
 *  3. a comment on it through B's path is refused, even for the owner; through A's, it posts;
 *  4. a document in B cannot promote it (400); a deck in B can be promoted;
 *  5. a present-remote token naming org B does not drive it (404); one naming A does;
 *  6. the ui-plugin demo artifact: in prod's posture (enforcement unset) an
 *     anonymous call gets one only in its own tenant; under enforcement a
 *     non-member of the shared tenant is refused (`artifacts:read`).
 *
 * Sabotage notes: `collabCanvasReadable` back to the owner-only check reds 1;
 * dropping the link-org match in `canvasEntitlement` reds 2; dropping the org
 * match in `canvas_slides` reds 3; the promotedCanvasId check back to existence
 * reds 4; dropping the token-org match in `authorizePresentRemote` reds 5;
 * dropping the scope on demo-artifact reds 6.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { mintPresentRemoteToken } from '../src/host/presentRemote.js';
import { getCanvasForTenant } from '../src/host/canvasSurface.js';

let BASE: string;
let server: http.Server;
let n = 0;

interface Res<T> { status: number; body: T }
interface Client { get<T>(p: string): Promise<Res<T>>; post<T>(p: string, b?: unknown): Promise<Res<T>>; patch<T>(p: string, b?: unknown): Promise<Res<T>> }
function client(): Client {
  let cookie = '';
  async function call<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `c1160p2-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}
const enc = encodeURIComponent;
const SL = (org: string): string => `/host/openwop-app/slides/orgs/${enc(org)}/canvases`;

let tenantId: string;
let orgA: string; let orgB: string;
let owner: Client; let edA: Client; let edB: Client;
let ownerId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['slides', 'documents', 'sharing', 'comments', 'realtime-collab']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  tenantId = `org:c1160p2-${Date.now()}`;
  owner = client(); ownerId = await signup(owner, tenantId);
  edA = client(); const edAId = await signup(edA, tenantId);
  edB = client(); const edBId = await signup(edB, tenantId);
  orgA = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Workspace A' })).body.orgId;
  orgB = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Workspace B' })).body.orgId;
  await owner.post(`/host/openwop-app/test/orgs/${enc(orgA)}/members`, { displayName: 'A', subject: edAId, roles: ['editor'] });
  await owner.post(`/host/openwop-app/test/orgs/${enc(orgB)}/members`, { displayName: 'B', subject: edBId, roles: ['editor'] });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function deckIn(org: string): Promise<string> {
  const r = await owner.post<{ canvasId: string; orgId?: string }>(SL(org), { name: `Deck ${n++}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.orgId, 'fixture: P0 stamps the path org').toBe(org);
  return r.body.canvasId;
}

describe('ADR 1160 P2 — the stray lanes decide in the canvas’s org', () => {
  it('1. live collaboration: no ticket from another org', async () => {
    const id = await deckIn(orgA);
    expect((await edB.post(`/host/openwop-app/canvas-collab/${enc(id)}/ticket`, {})).status).toBe(404);
    expect((await edA.post(`/host/openwop-app/canvas-collab/${enc(id)}/ticket`, {})).status).toBeLessThan(300);
  });

  it('2. a share link is minted only through the canvas’s org', async () => {
    const id = await deckIn(orgA);
    const viaB = await owner.post(`/host/openwop-app/sharing/orgs/${enc(orgB)}/links`, { resourceType: 'slides_canvas', resourceId: id });
    expect(viaB.status, JSON.stringify(viaB.body)).toBe(404);
    const viaA = await owner.post(`/host/openwop-app/sharing/orgs/${enc(orgA)}/links`, { resourceType: 'slides_canvas', resourceId: id });
    expect(viaA.status, JSON.stringify(viaA.body)).toBe(201);
  });

  it('3. a comment is posted only through the canvas’s org', async () => {
    const id = await deckIn(orgA);
    // The owner is in BOTH orgs, so only the path-org match can refuse this.
    const viaB = await owner.post(`/host/openwop-app/comments/orgs/${enc(orgB)}/comments`, { resourceType: 'canvas_slides', resourceId: id, body: 'from B' });
    expect(viaB.status, JSON.stringify(viaB.body)).toBeGreaterThanOrEqual(400);
    expect((await edB.post(`/host/openwop-app/comments/orgs/${enc(orgB)}/comments`, { resourceType: 'canvas_slides', resourceId: id, body: 'from B' })).status).toBeGreaterThanOrEqual(400);
    const viaA = await edA.post(`/host/openwop-app/comments/orgs/${enc(orgA)}/comments`, { resourceType: 'canvas_slides', resourceId: id, body: 'from A' });
    expect(viaA.status, JSON.stringify(viaA.body)).toBe(201);
  });

  it('4. a document promotes only a canvas of its own org', async () => {
    const idA = await deckIn(orgA);
    const idB = await deckIn(orgB);
    const doc = await owner.post<{ documentId: string }>(`/host/openwop-app/documents/orgs/${enc(orgB)}/documents`, { title: 'B doc', kind: 'prd' });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    const D = `/host/openwop-app/documents/orgs/${enc(orgB)}/documents/${enc(doc.body.documentId)}`;
    expect((await owner.patch(D, { promotedCanvasId: idA })).status).toBe(400);
    expect((await owner.patch(D, { promotedCanvasId: idB })).status).toBe(200);
  });

  it('5. a present-remote token drives only a canvas of its own org', async () => {
    const id = await deckIn(orgA);
    const wrong = mintPresentRemoteToken(tenantId, id, { userId: ownerId, orgId: orgB }).token;
    expect((await owner.get(`/host/openwop-app/present/${enc(wrong)}/outline`)).status).toBe(404);
    const right = mintPresentRemoteToken(tenantId, id, { userId: ownerId, orgId: orgA }).token;
    expect((await owner.get(`/host/openwop-app/present/${enc(right)}/outline`)).status).toBe(200);
  });

  it('6. the ui-plugin demo artifact needs artifacts:read (the RPC that reads it asks the same)', async () => {
    // Under enforcement: a signed-in caller with no membership in this shared
    // tenant is refused; the owner is not. (Unenforced, and in a caller's own
    // personal workspace, the scope passes by design, as for the RPC.)
    const prev = process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
    // PROD posture (openwop-dev and the white-label default leave enforcement
    // unset, read 2026-11-25): an anonymous caller gets the demo artifact, but
    // only in its OWN tenant (`tenantOf` is the active, membership-gated
    // tenant), never in another's.
    delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
    const anonRes = await fetch(`${BASE}/host/openwop-app/ui-plugin/demo-artifact`, { method: 'POST' });
    expect(anonRes.status).toBe(200);
    const anonArtifact = ((await anonRes.json()) as { artifactId: string }).artifactId;
    expect(await getCanvasForTenant(tenantId, anonArtifact), 'not written into another tenant').toBeNull();
    process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = 'true';
    try {
      const stranger = client(); await signup(stranger, tenantId);
      expect((await stranger.post('/host/openwop-app/ui-plugin/demo-artifact')).status).toBe(403);
      expect((await owner.post('/host/openwop-app/ui-plugin/demo-artifact')).status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT; else process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = prev;
    }
  });
});
