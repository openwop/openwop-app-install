/**
 * ADR 1160 D4 — the operator backfill route (the user's choice, 2026-11-25:
 * a superadmin route, dry run first, then apply).
 *
 *  1. a non-superadmin gets 403 on GET and POST;
 *  2. GET is a dry run: counts and a digest, nothing written, no canvas or
 *     tenant ids in the body;
 *  3. POST without the digest is 400; with a stale digest (a canvas created
 *     since) it is 409 `plan_changed` and writes nothing;
 *  4. POST with the reviewed digest places exactly the planned canvases, and a
 *     second dry run then has nothing to place for them.
 *
 * Sabotage notes: dropping `requireSuperadmin` on POST reds 1; skipping the
 * digest comparison reds 3 (the stale apply writes).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createCanvasForTenant, getCanvasForTenant } from '../src/host/canvasSurface.js';

let BASE: string;
let server: http.Server;
let n = 0;

interface Res<T> { status: number; body: T; raw: string }
interface Client { get<T>(p: string): Promise<Res<T>>; post<T>(p: string, b?: unknown): Promise<Res<T>> }
function client(): Client {
  let cookie = '';
  async function call<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}
const R = '/host/openwop-app/operations/canvas-org-backfill';
interface Summary { dryRun: boolean; tenants: number; unstamped: number; place: { oneOrgTenant: number; projectOwned: number }; leftShared: number; digest: string; outcome?: Record<string, number> }

let admin: Client; let outsider: Client;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  admin = client(); outsider = client();
  await admin.post('/host/openwop-app/test/login', { email: `bf-admin-${Date.now()}@acme.test` });
  await outsider.post('/host/openwop-app/test/login', { email: `bf-out-${Date.now()}@acme.test` });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { vi.unstubAllEnvs(); });

async function asSuperadmin(): Promise<void> {
  const personal = (await admin.get<{ personal: string }>('/host/openwop-app/me/workspaces')).body.personal;
  vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', personal);
}
const shared = (tenantId: string) => createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', orgId: null, orgWhy: 'system:test-legacy', initialState: { v: n++ } });

describe('ADR 1160 D4 — the superadmin backfill route', () => {
  it('1. is superadmin-only', async () => {
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', '');
    expect((await outsider.get(R)).status).toBe(403);
    expect((await outsider.post(R, { digest: '0'.repeat(64) })).status).toBe(403);
  });

  it('2. GET is a dry run: counts and a digest, no ids, nothing written', async () => {
    const T = `t-bf-2-${Date.now()}`; const O = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Only', ownerSubject: 'own' })).orgId;
    const c = await shared(T);
    await asSuperadmin();
    const r = await admin.get<Summary>(R);
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(r.body.place.oneOrgTenant).toBeGreaterThanOrEqual(1);
    expect(r.raw).not.toContain(c.canvasId);
    expect(r.raw).not.toContain(T);
    expect(r.raw).not.toContain(O);
    expect((await getCanvasForTenant(T, c.canvasId))?.orgId, 'nothing written').toBeUndefined();
  });

  it('3. an apply needs the reviewed digest; a stale one writes nothing', async () => {
    const T = `t-bf-3-${Date.now()}`; await createOrg({ tenantId: T, createdBy: 'own', name: 'Only', ownerSubject: 'own' });
    const c = await shared(T);
    await asSuperadmin();
    expect((await admin.post(R, {})).status).toBe(400);
    const { digest } = (await admin.get<Summary>(R)).body;
    await shared(T); // the plan changes after review
    const stale = await admin.post<{ details?: { reason?: string } }>(R, { digest });
    expect(stale.status, stale.raw).toBe(409);
    expect(stale.body.details?.reason).toBe('plan_changed');
    expect((await getCanvasForTenant(T, c.canvasId))?.orgId, 'nothing written').toBeUndefined();
  });

  it('4. the reviewed digest places exactly the plan, and then nothing is left for it', async () => {
    const T = `t-bf-4-${Date.now()}`; const O = (await createOrg({ tenantId: T, createdBy: 'own', name: 'Only', ownerSubject: 'own' })).orgId;
    const a = await shared(T); const b = await shared(T);
    await asSuperadmin();
    const dry = (await admin.get<Summary>(R)).body;
    const applied = await admin.post<Summary>(R, { digest: dry.digest });
    expect(applied.status, applied.raw).toBe(200);
    expect(applied.body.outcome?.claimed).toBe(dry.place.oneOrgTenant + dry.place.projectOwned);
    expect((await getCanvasForTenant(T, a.canvasId))?.orgId).toBe(O);
    expect((await getCanvasForTenant(T, b.canvasId))?.orgId).toBe(O);
    const after = (await admin.get<Summary>(R)).body;
    expect(after.place.oneOrgTenant + after.place.projectOwned).toBe(0);
  });
});
