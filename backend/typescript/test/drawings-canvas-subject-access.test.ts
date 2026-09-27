/**
 * `DRC-1` — the ADR 0610 / CPC-15 subject-access gate covers the DRAWINGS read path.
 *
 * The row that prompted this carried its own verification instruction: *"Closed by the
 * in-flight ADR 0610 shared `loadCanvas` choke gate — drawings inherits via
 * `registerCanvasEditorRoutes`. Confirm on merge; if ADR 0610's gate does not cover the
 * drawings read path, this REOPENS as a real High."* Confirmed at HEAD by reading
 * (`canvasEditorRoutes.ts:201-209`) — and now PINNED, because for `canvas.drawing`
 * nothing asserted it: the gate was covered for `canvas.document` and the kicktodo
 * outline, and drawings held it purely by inheritance.
 *
 * Inheritance is exactly the kind of protection that disappears quietly. A drawings
 * feature that ever registered a bespoke read route, or a refactor that moved the gate
 * out of the shared choke, would leave every other canvas type's test green.
 *
 * The subject here is a PRIVATE project: B is a real org member with `workspace:read`,
 * so org scope alone would admit them. Refusal must be a uniform 404 — no existence leak.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { createMember } from '../src/host/accessControlService.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['drawings', 'projects']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Client { cookie: string; userId: string; get: (p: string) => Promise<any>; post: (p: string, b?: unknown) => Promise<any>; patch: (p: string, b?: unknown) => Promise<any> }
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

const P = '/v1/host/openwop-app/projects';

/** A project-owned `canvas.drawing` in a PRIVATE project, plus a same-tenant org member
 *  who is NOT a project member — the case org scope alone would wrongly admit. */
async function privateProjectDrawing() {
  const tenantId = `org:drw-sa-${Date.now()}-${n++}`;
  const a = await loginTo(tenantId, 'owner');
  const orgId = (await a.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const projectId = (await a.post(P, { orgId, name: 'Secret' })).body.id;
  expect((await a.patch(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
  const canvas = await createCanvasForTenant(tenantId, {
    canvasTypeId: 'canvas.drawing', name: 'Secret sketch',
    ownerSubject: { kind: 'project', id: projectId },
    initialState: { title: 'Secret sketch', shapes: [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10 }] },
  });
  const b = await loginTo(tenantId, 'nonmember');
  await createMember({ tenantId, orgId, subject: b.userId, displayName: 'B', roles: ['viewer'] });
  return { orgId, canvasId: canvas.canvasId, a, b };
}

const DRW = (orgId: string): string => `/v1/host/openwop-app/drawings/orgs/${encodeURIComponent(orgId)}`;

describe('DRC-1 — a private project\'s drawing is member-gated on the REST read', () => {
  it('the project member CAN read it (the gate must not over-refuse)', async () => {
    const { orgId, canvasId, a } = await privateProjectDrawing();
    const r = await a.get(`${DRW(orgId)}/canvases/${canvasId}`);
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
    expect(r.body.canvasId).toBe(canvasId);
  }, 60_000);

  it('a same-tenant ORG member who is NOT a project member gets a uniform 404', async () => {
    const { orgId, canvasId, b } = await privateProjectDrawing();
    const r = await b.get(`${DRW(orgId)}/canvases/${canvasId}`);
    expect(r.status, 'org scope alone must not admit a private project canvas').toBe(404);
    // 404, not 403 — a refusal must not confirm the drawing exists.
    expect(JSON.stringify(r.body ?? {}), 'no existence leak in the error body').not.toContain('Secret sketch');
  }, 60_000);

  it('STRUCTURAL: drawings registers through the shared chassis, so it cannot drift off the choke', () => {
    const routes = readFileSync(new URL('../src/features/drawings/routes.ts', import.meta.url), 'utf8');
    expect(routes, 'a bespoke read route here would bypass the ADR 0610 gate').toContain('registerCanvasEditorRoutes');
    expect(routes).not.toMatch(/app\.get\(/);
  });
});
