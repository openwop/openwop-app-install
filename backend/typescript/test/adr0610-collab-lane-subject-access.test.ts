/**
 * ADR 0610 collab-lane follow-up / SLC-1 — the collab lane is the un-enumerated
 * SIBLING door of the REST `loadCanvas` choke. ADR 0610 (#3499) gated the REST
 * read doors on `resolveSubjectAccess`, but `host/collab/collabServer.ts`
 * (ticket-mint, claim-seed, and the WS upgrade) authorized on tenant + canvas-type
 * + toggle ONLY — no `caller`, no project-membership check. So a private-project
 * `canvas.*` deck that is 404 to a same-tenant NON-member on REST GET could still
 * be opened for full co-edit by that non-member (with `realtime-collab` on).
 *
 * WRITE stays org-scoped (ADR 0054); collab join needs READ, so a project MEMBER
 * (read) and any `workspace:write` holder still get in — only a non-member of a
 * PRIVATE project is refused. Bounded to same-tenant (cross-tenant already 404s).
 *
 * @see docs/adr/0610-owner-subject-access-and-egress-allowlist.md
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { attachCollabWebSocket, __resetCollabConns } from '../src/host/collab/collabServer.js';
import { __resetCollabRooms, __stopCollabLeaseHeartbeat, __stopCollabUpdateSweep } from '../src/host/collab/collabRoom.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { createMember } from '../src/host/accessControlService.js';

const ORIGIN = 'http://localhost:9977';
let BASE: string;
let WSBASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_CORS_ORIGINS = ORIGIN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    BASE = `http://127.0.0.1:${port}`; WSBASE = `ws://127.0.0.1:${port}`; res();
  }); });
  attachCollabWebSocket(server);
  for (const id of ['realtime-collab', 'document-editor', 'projects']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { __stopCollabLeaseHeartbeat(); __stopCollabUpdateSweep(); __resetCollabRooms(); __resetCollabConns(); delete process.env.OPENWOP_CORS_ORIGINS; await new Promise<void>((res) => server.close(() => res())); });

interface Client { cookie: string; userId: string; get: (p: string) => Promise<any>; post: (p: string, b?: unknown) => Promise<any>; patch: (p: string, b?: unknown) => Promise<any> }
/** Log a user into a SPECIFIC tenant (so two users can share one tenant). */
async function loginTo(tenantId: string, who: string): Promise<Client> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { cookie, userId: r.body.user.userId, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

async function mintTicket(cookie: string, canvasId: string): Promise<{ status: number; ticket?: string }> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}/ticket`, { method: 'POST', headers: { cookie } });
  if (!res.ok) return { status: res.status };
  return { status: res.status, ticket: ((await res.json()) as { ticket: string }).ticket };
}
async function claimSeed(cookie: string, canvasId: string): Promise<number> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}/claim-seed`, { method: 'POST', headers: { cookie } });
  return res.status;
}
function connect(canvasId: string, headers: Record<string, string>, query = ''): Promise<{ open: boolean; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}/v1/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}${query}`, { headers });
    const done = (r: { open: boolean; status?: number }) => { try { ws.terminate(); } catch { /* ignore */ } resolve(r); };
    ws.on('open', () => done({ open: true }));
    ws.on('unexpected-response', (_req, res) => done({ open: false, status: res.statusCode }));
    ws.on('error', () => resolve({ open: false }));
  });
}

const P = '/v1/host/openwop-app/projects';

/** Owner A (a project member of a PRIVATE project) + a project-owned canvas.document,
 *  in a tenant shared with a non-member B. */
async function privateProjectCanvas() {
  const tenantId = `org:slc1-${Date.now()}-${n++}`;
  const a = await loginTo(tenantId, 'owner');
  const orgId = (await a.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const projectId = (await a.post(P, { orgId, name: 'Secret' })).body.id;
  expect((await a.patch(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
  const canvas = await createCanvasForTenant(tenantId, {
    canvasTypeId: 'canvas.document', name: 'Secret deck',
    ownerSubject: { kind: 'project', id: projectId },
    initialState: { title: 'Secret deck', content: { type: 'doc', content: [] } },
  });
  const b = await loginTo(tenantId, 'nonmember'); // same tenant + org, but NOT a project member
  // B is a real ORG member (workspace:read) — the precise "org reader, non-project-member"
  // case: refused on a PRIVATE project even though org-scope alone would let them in.
  await createMember({ tenantId, orgId, subject: b.userId, displayName: 'B', roles: ['viewer'] });
  return { tenantId, orgId, projectId, canvasId: canvas.canvasId, a, b };
}

describe("ADR 0610 collab-lane / SLC-1 — a private project's canvas collab room is member-gated", () => {
  it('a same-tenant NON-member is REFUSED at ticket-mint, claim-seed, AND the WS upgrade', async () => {
    const { canvasId, a, b } = await privateProjectCanvas();

    // Positive controls FIRST (non-vacuity): the OWNER (a project member) gets in.
    expect((await mintTicket(a.cookie, canvasId)).status).toBe(200);
    expect(await connect(canvasId, { origin: ORIGIN, cookie: a.cookie })).toEqual({ open: true });

    // THE BYPASS: the non-member must be refused on every collab door.
    expect((await mintTicket(b.cookie, canvasId)).status).toBe(404);       // ticket-mint
    expect(await claimSeed(b.cookie, canvasId)).toBe(404);                  // claim-seed
    expect(await connect(canvasId, { origin: ORIGIN, cookie: b.cookie })).toEqual({ open: false, status: 404 }); // WS cookie join
  });

  it('a project MEMBER regains the collab room — mint AND open the WS with the ticket (the prod cross-origin posture)', async () => {
    const { projectId, canvasId, a, b } = await privateProjectCanvas();
    expect((await a.post(`${P}/${projectId}/members`, { ref: `user:${b.userId}`, role: 'observer' })).status).toBe(201);
    const minted = await mintTicket(b.cookie, canvasId);
    expect(minted.status).toBe(200); // member (read) may mint
    // THE REGRESSION GUARD (adversarial-review #4): a member who minted MUST be able
    // to open the WS WITH that ticket — the prod posture (mint over /api, WS-join on
    // the direct origin, NO cookie). A caller-format mismatch between mint + WS would
    // deny the member's own ticket. Open WITHOUT the cookie, ticket only.
    expect(await connect(canvasId, { origin: ORIGIN }, `?ticket=${encodeURIComponent(minted.ticket!)}`)).toEqual({ open: true });
  });

  it('the OWNER opens the WS with a ticket too (owner ticket-path control)', async () => {
    const { canvasId, a } = await privateProjectCanvas();
    const minted = await mintTicket(a.cookie, canvasId);
    expect(minted.status).toBe(200);
    expect(await connect(canvasId, { origin: ORIGIN }, `?ticket=${encodeURIComponent(minted.ticket!)}`)).toEqual({ open: true });
  });
});
