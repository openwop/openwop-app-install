/**
 * ADR 0833 S1 / D1 + S4 / D4 — the collaboration WebSocket asks the SAME
 * live-session and credentialed-origin questions as the HTTP middleware.
 *
 * RED on `97baad74b`: the cookie lane called bare `verifySession`, so a
 * disabled, epoch-revoked or removed member still opened the workspace's canvas
 * rooms (Yjs read AND write) until the cookie's `exp`; and with a cross-site
 * cookie and no allowlist, any Origin was admitted (CSWSH).
 *
 * The REMOVED-member refusal is a DOUBLE guard in host/collab/collabServer.ts:
 * the cookie lane's `cookieSession.repinned` check (403 'forbidden') AND, since
 * the session still names the workspace, the canvas lane's
 * `assertTenantScope(…, 'workspace:write')` (403 'forbidden'). Removing one alone
 * stays green (w62 probe); removing both reds the case.
 *
 * Tracker TST-BCL-1. Sabotage-witnessed (w62): red when the cookie lane stops
 * asking `assertSessionSubjectLive` (disabled, signed out), both removed-member
 * guards are dropped, or the credentialed-origin check admits any Origin.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { attachCollabWebSocket, __resetCollabConns } from '../src/host/collab/collabServer.js';
import { __resetCollabRooms, __stopCollabLeaseHeartbeat, __stopCollabUpdateSweep } from '../src/host/collab/collabRoom.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { createMember, createWorkspace, deleteMember } from '../src/host/accessControlService.js';
import { bumpSessionEpoch, setUserStatus, userIdFor } from '../src/features/users/usersService.js';

const ORIGIN = 'http://localhost:9978';
let BASE = '';
let WSBASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_CORS_ORIGINS = ORIGIN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    BASE = `http://127.0.0.1:${port}`;
    WSBASE = `ws://127.0.0.1:${port}`;
    res();
  }); });
  attachCollabWebSocket(server);
  for (const id of ['realtime-collab', 'document-editor']) {
    const t = getToggleDefault(id);
    if (t) await saveConfig({ ...t, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  __stopCollabLeaseHeartbeat(); __stopCollabUpdateSweep(); __resetCollabRooms(); __resetCollabConns();
  delete process.env.OPENWOP_CORS_ORIGINS;
  await new Promise<void>((res) => server.close(() => res()));
});

async function login(subject: string, tenantId: string, sharedWorkspace: boolean): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, displayName: subject, tenantId, sharedWorkspace }),
  });
  expect(res.status).toBe(201);
  let cookie = '';
  for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
  const body = (await res.json()) as { user: { userId: string } };
  return { cookie, userId: body.user.userId };
}
interface Result { open: boolean; status?: number; reason?: string }
function connect(canvasId: string, headers: Record<string, string>): Promise<Result> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}`, { headers });
    const done = (r: Result): void => { try { ws.terminate(); } catch { /* ignore */ } resolve(r); };
    ws.on('open', () => done({ open: true }));
    ws.on('unexpected-response', (_req, res) => done({ open: false, status: res.statusCode, reason: res.statusMessage }));
    ws.on('error', () => resolve({ open: false }));
  });
}
async function makeDoc(tenantId: string): Promise<string> {
  const c = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
  return c.canvasId;
}

let seq = 0;
async function memberOfWorkspace(): Promise<{ ws: string; cookie: string; userId: string; memberId: string; canvasId: string }> {
  const subject = `oidc:adr0833-collab-${seq++}`;
  const w = await createWorkspace({ name: `collab ${seq}`, ownerSubject: 'user:placeholder-collab' });
  const m = await createMember({ orgId: w.tenantId, tenantId: w.tenantId, displayName: 'M', subject: userIdFor(w.tenantId, subject), roles: ['editor'] });
  const { cookie, userId } = await login(subject, w.tenantId, true);
  const canvasId = await makeDoc(w.tenantId);
  return { ws: w.tenantId, cookie, userId, memberId: m.memberId, canvasId };
}

describe('S1 / D1 — the cookie lane asks the session authority', () => {
  it('precondition: a live member opens the room', async () => {
    const m = await memberOfWorkspace();
    expect(await connect(m.canvasId, { cookie: m.cookie, origin: ORIGIN })).toEqual({ open: true });
  });

  it('a DISABLED account is refused (401)', async () => {
    const m = await memberOfWorkspace();
    await setUserStatus(m.userId, 'disabled', { reason: 'admin' });
    expect(await connect(m.canvasId, { cookie: m.cookie, origin: ORIGIN })).toEqual({ open: false, status: 401, reason: 'unauthenticated' });
  });

  it('a "sign out everywhere" (epoch bump) is refused (401)', async () => {
    const m = await memberOfWorkspace();
    await bumpSessionEpoch(m.userId);
    expect(await connect(m.canvasId, { cookie: m.cookie, origin: ORIGIN })).toEqual({ open: false, status: 401, reason: 'unauthenticated' });
  });

  it('a member REMOVED from the workspace is refused (403)', async () => {
    const m = await memberOfWorkspace();
    await deleteMember(m.memberId);
    expect(await connect(m.canvasId, { cookie: m.cookie, origin: ORIGIN })).toEqual({ open: false, status: 403, reason: 'forbidden' });
  });
});

describe('S4 / D4 — no allowlist + a cross-site cookie ⇒ same-origin only, on the socket too', () => {
  afterEach(() => {
    process.env.OPENWOP_CORS_ORIGINS = ORIGIN;
    delete process.env.OPENWOP_COOKIE_SECURE;
  });

  it('a foreign Origin is refused (403); the host’s own origin opens', async () => {
    const m = await memberOfWorkspace();
    delete process.env.OPENWOP_CORS_ORIGINS;
    process.env.OPENWOP_COOKIE_SECURE = 'true';
    expect(await connect(m.canvasId, { cookie: m.cookie, origin: 'https://evil.example' })).toEqual({ open: false, status: 403, reason: 'forbidden origin' });
    expect(await connect(m.canvasId, { cookie: m.cookie, origin: BASE })).toEqual({ open: true });
  });
});
