/**
 * ADR 0458 grade-pass B1 — the challenge-outline canvas surface is
 * `host:kicktodo:manage` privileged, at the HTTP boundary.
 *
 * Before this fix the chassis CRUD/versions/collab routes registered by
 * `registerCanvasEditorRoutes` were reachable by any `workspace:write` member,
 * while every sibling Factory route (ensure/apply/publish/kill) required
 * `host:kicktodo:manage`. The fix adds an optional per-type `authorize` predicate
 * the chassis runs AFTER its feature/scope check on every route + the collab
 * ticket-mint path; challenge-outline passes the SAME `requireKicktodoManage`.
 *
 * This suite closes the HTTP half GC-1 left open (`kicktodo-authz-scope.test.ts`):
 * it mints a SHARED-workspace session whose ACTIVE tenant differs from the
 * caller's personal tenant — a condition `test/login` could not produce WHEN THIS
 * WAS WRITTEN, since that seam pinned `personalTenant = active tenant` and so
 * vacuously satisfied the `isOwnPersonalWorkspace` short-circuit. (CORRECTION,
 * H52 2026-08-18: the seam has since grown `sharedWorkspace: true` — ADR 0506 /
 * ADR 0554 §P3 — and `kicktodo-authz-http.test.ts` now proves the same 9 chassis
 * verbs, plus every other `requireKicktodoManage` route, through it. This suite
 * stays as the deeper per-verb proof on a REAL canvas + the collab ticket + the
 * per-type no-regression check.) We sign the session directly (same HMAC the
 * middleware verifies) to get a real member acting in a workspace they do NOT
 * own, then assert:
 *   - an EDITOR (workspace:write, NO manage) is uniformly denied on
 *     GET/PATCH/DELETE/versions AND the collab ticket for the outline canvas;
 *   - the SAME editor still reads an app-builder canvas (the hook is per-type — no
 *     regression to the other six canvas types);
 *   - an ADMIN (manage) succeeds on all of them.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createCanvasForTenant, getCanvasForTenant } from '../src/host/canvasSurface.js';
import { CHALLENGE_OUTLINE_CANVAS_TYPE } from '../src/features/kicktodo-creator/outlineDoc.js';

let BASE: string;
let server: http.Server;
let TENANT: string; // the shared workspace root (orgId === tenantId)
let editorCookie: string;
let adminCookie: string;
let outlineCanvasId: string;
let appBuilderCanvasId: string;

/** Sign a user-tier session whose ACTIVE tenant is the shared workspace while the
 *  caller's PERSONAL tenant is elsewhere — so `isOwnPersonalWorkspace` is false and
 *  the manage gate is actually exercised (not short-circuited). `personalTenant` is
 *  deliberately NOT `user:`-prefixed so `resolveCallerUser` resolves the durable
 *  member by `userId` (in the shared tenant) rather than canonicalizing to a
 *  personal tenant. */
function craftCookie(userId: string, activeTenant: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

async function seatMember(principalId: string, roles: string[], personalTenant: string): Promise<string> {
  const user = await upsertFromPrincipal({ tenantId: TENANT, principalId, source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: user.userId, displayName: principalId, roles });
  return craftCookie(user.userId, TENANT, personalTenant);
}

/** The response fields this suite reads — narrowed from `unknown`, no casts. */
interface Body { error?: string; code?: string; message?: string; canvasId?: string; ticket?: string }
interface Res { status: number; body: Body | undefined; raw: string }
function asBody(v: unknown): Body | undefined {
  if (!v || typeof v !== 'object') return undefined;
  return {
    ...('error' in v && typeof v.error === 'string' ? { error: v.error } : {}),
    ...('code' in v && typeof v.code === 'string' ? { code: v.code } : {}),
    ...('message' in v && typeof v.message === 'string' ? { message: v.message } : {}),
    ...('canvasId' in v && typeof v.canvasId === 'string' ? { canvasId: v.canvasId } : {}),
    ...('ticket' in v && typeof v.ticket === 'string' ? { ticket: v.ticket } : {}),
  };
}
async function call(cookie: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: asBody(parsed), raw };
}

/** The refusal must be the MANAGE hook's — the chassis stacks `requireOrgScope`,
 *  whose 403 names a different scope (same discriminator as kicktodo-authz-http). */
function expectManageRefusal(r: Res): void {
  expect(r.status, r.raw).toBe(403);
  expect(r.raw, 'a 403 from a different gate is not this proof').toContain('host:kicktodo:manage');
}

const OUT = (rest: string): string => `/host/openwop-app/challenge-outline/orgs/${encodeURIComponent(TENANT)}${rest}`;
const AB = (rest: string): string => `/host/openwop-app/app-builder/orgs/${encodeURIComponent(TENANT)}${rest}`;
const TICKET = (canvasId: string): string => `/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}/ticket`;

function skeleton(): Record<string, unknown> {
  return { meta: { title: 'T', promise: 'P', audience: 'A', durationDays: 7, dailyMinutesBudget: 15 }, outcomes: [], achievements: [], frames: [{ id: 'outline', name: 'T', days: [] }] };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kicktodo-core', 'kicktodo-creator', 'realtime-collab', 'app-builder']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'KT Studio', ownerSubject: 'oidc:kt-owner' });
  TENANT = ws.tenantId;
  editorCookie = await seatMember('oidc:kt-editor', ['editor'], 'ws:home-editor');
  adminCookie = await seatMember('oidc:kt-admin', ['admin'], 'ws:home-admin');
  outlineCanvasId = (await createCanvasForTenant(TENANT, { canvasTypeId: CHALLENGE_OUTLINE_CANVAS_TYPE, name: 'Outline', initialState: skeleton() })).canvasId;
  appBuilderCanvasId = (await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.app-builder', name: 'App', initialState: { screens: [] } })).canvasId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('B1 — an editor (workspace:write, NO manage) is denied on the outline canvas', () => {
  it('GET is 403 forbidden_scope (not a leaky 404)', async () => {
    const r = await call(editorCookie, 'GET', OUT(`/canvases/${outlineCanvasId}`));
    expectManageRefusal(r);
    expect(r.body?.error ?? r.body?.code).toContain('forbidden_scope');
  });

  it('PATCH is 403 and mutates nothing', async () => {
    const before = await getCanvasForTenant(TENANT, outlineCanvasId);
    expect(before, 'the outline canvas must exist for "mutates nothing" to mean anything').not.toBeNull();
    const tampered = { ...skeleton(), meta: { title: 'EDITOR-WROTE', promise: 'P', audience: 'A', durationDays: 7, dailyMinutesBudget: 15 } };
    const r = await call(editorCookie, 'PATCH', OUT(`/canvases/${outlineCanvasId}`), { state: tampered });
    expectManageRefusal(r);
    // Read the STORED canvas back: neither the state nor the version moved.
    const after = await getCanvasForTenant(TENANT, outlineCanvasId);
    expect(after?.state).toEqual(before!.state);
    expect(after?.version).toBe(before!.version);
  });

  it('the versions list is 403', async () => {
    expectManageRefusal(await call(editorCookie, 'GET', OUT(`/canvases/${outlineCanvasId}/versions`)));
  });

  it('the collab ticket mint is refused (403)', async () => {
    const r = await call(editorCookie, 'POST', TICKET(outlineCanvasId));
    expectManageRefusal(r);
    expect(r.body?.ticket).toBeUndefined();
  });

  it('DELETE is 403 — the canvas survives (proven by the admin reading it afterwards)', async () => {
    expectManageRefusal(await call(editorCookie, 'DELETE', OUT(`/canvases/${outlineCanvasId}`)));
    expect(await getCanvasForTenant(TENANT, outlineCanvasId)).not.toBeNull();
    expect((await call(adminCookie, 'GET', OUT(`/canvases/${outlineCanvasId}`))).status).toBe(200);
  });

  it('NO REGRESSION — the same editor still reads an app-builder canvas (the hook is per-type)', async () => {
    const r = await call(editorCookie, 'GET', AB(`/canvases/${appBuilderCanvasId}`));
    expect(r.status).toBe(200);
    expect(r.body?.canvasId).toBe(appBuilderCanvasId);
  });
});

describe('B1 — an admin (host:kicktodo:manage) succeeds on the outline canvas', () => {
  it('GET, versions, PATCH and the collab ticket all succeed', async () => {
    expect((await call(adminCookie, 'GET', OUT(`/canvases/${outlineCanvasId}`))).status).toBe(200);
    expect((await call(adminCookie, 'GET', OUT(`/canvases/${outlineCanvasId}/versions`))).status).toBe(200);
    expect((await call(adminCookie, 'PATCH', OUT(`/canvases/${outlineCanvasId}`), { state: skeleton() })).status).toBe(200);
    const ticket = await call(adminCookie, 'POST', TICKET(outlineCanvasId));
    expect(ticket.status).toBe(200);
    expect(typeof ticket.body?.ticket).toBe('string');
  });

  it('DELETE succeeds for the admin (on its own canvas, so case order does not matter)', async () => {
    const own = (await createCanvasForTenant(TENANT, { canvasTypeId: CHALLENGE_OUTLINE_CANVAS_TYPE, name: 'Outline (admin delete)', initialState: skeleton() })).canvasId;
    expect((await call(adminCookie, 'DELETE', OUT(`/canvases/${own}`))).status).toBe(204);
    expect(await getCanvasForTenant(TENANT, own)).toBeNull();
    expect((await call(adminCookie, 'GET', OUT(`/canvases/${own}`))).status).toBe(404);
  });
});
