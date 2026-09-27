/**
 * ADR 0335 Phase 1 — the collaboration WebSocket AUTH BOUNDARY (dormant; no Yjs
 * sync yet). Boots the real app + attaches the collab WS to the test server, then
 * proves auth-on-connect fails closed: a valid session+canvas+origin upgrades
 * (101 open); a raw upgrade with no cookie is 401; a cross-tenant / wrong-type
 * canvas is a uniform 404; a disallowed Origin is 403 (CSWSH); the toggle OFF is
 * 404 (advertises nothing).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { getSetCookies } from './headerCookies.js';
import { verifySession } from '../src/middleware/cookieSession.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { attachCollabWebSocket, __resetCollabConns, mintCollabTicket, verifyCollabTicket } from '../src/host/collab/collabServer.js';
import { __resetCollabRooms, __stopCollabLeaseHeartbeat, __stopCollabUpdateSweep } from '../src/host/collab/collabRoom.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { collabCanvasType } from '../src/host/collab/collabRegistry.js';

const ORIGIN = 'http://localhost:9977';
let BASE: string;      // http origin
let WSBASE: string;    // ws origin
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_CORS_ORIGINS = ORIGIN; // explicit allowlist → CSWSH check active
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    BASE = `http://127.0.0.1:${port}`;
    WSBASE = `ws://127.0.0.1:${port}`;
    res();
  }); });
  attachCollabWebSocket(server);
  const collab = getToggleDefault('realtime-collab');
  if (collab) await saveConfig({ ...collab, status: 'on' }, 'test');
  // ADR 0359 — the socket enforces the canvas type's OWN toggle too.
  const de = getToggleDefault('document-editor');
  if (de) await saveConfig({ ...de, status: 'on' }, 'test');
});
afterAll(async () => { __stopCollabLeaseHeartbeat(); __stopCollabUpdateSweep(); __resetCollabRooms(); __resetCollabConns(); delete process.env.OPENWOP_CORS_ORIGINS; await new Promise<void>((res) => server.close(() => res())); });

let n = 0;
/** Log in a fresh tenant, returning its cookie + tenantId. */
async function login(): Promise<{ cookie: string; tenantId: string }> {
  const tenantId = `org:collab-${Date.now()}-${n++}`;
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `collab-${Date.now()}-${n++}@acme.test`, tenantId }),
  });
  expect(res.status).toBe(201);
  let cookie = '';
  for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
  return { cookie, tenantId };
}

interface Result { open: boolean; status?: number }
function connect(canvasId: string, headers: Record<string, string>, query = '', root = '/v1/host/openwop-app'): Promise<Result> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}${root}/canvas-collab/${encodeURIComponent(canvasId)}${query}`, { headers });
    const done = (r: Result) => { try { ws.terminate(); } catch { /* ignore */ } resolve(r); };
    ws.on('open', () => done({ open: true }));
    ws.on('unexpected-response', (_req, res) => done({ open: false, status: res.statusCode }));
    ws.on('error', () => resolve({ open: false }));
  });
}

async function makeDoc(tenantId: string): Promise<string> {
  const c = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
  return c.canvasId;
}

describe('collab WS auth boundary (ADR 0335 Phase 1)', () => {
  it('upgrades a valid session + own canvas + allowed origin (101 open)', async () => {
    const { cookie, tenantId } = await login();
    const canvasId = await makeDoc(tenantId);
    expect(await connect(canvasId, { cookie, origin: ORIGIN })).toEqual({ open: true });
  });

  // ADR 0671 moved the SPA to the canonical, version-agnostic `/host/<org>/…`
  // root (RFC 0181). Express rewrites that onto the `/v1` twin, but a raw
  // upgrade never reaches Express — so the upgrade matcher must accept it
  // itself, or every live-collab socket the SPA opens hangs un-upgraded and the
  // editor sits on "Reconnecting…" (collab.spec's two-client sync red).
  it('upgrades on the CANONICAL root the SPA sends — /host/… and /api/host/… (ADR 0671)', async () => {
    const { cookie, tenantId } = await login();
    const canvasId = await makeDoc(tenantId);
    expect(await connect(canvasId, { cookie, origin: ORIGIN }, '', '/host/openwop-app')).toEqual({ open: true });
    expect(await connect(canvasId, { cookie, origin: ORIGIN }, '', '/api/host/openwop-app')).toEqual({ open: true });
  });

  it('rejects a missing session cookie (401)', async () => {
    const { tenantId } = await login();
    const canvasId = await makeDoc(tenantId);
    expect(await connect(canvasId, { origin: ORIGIN })).toEqual({ open: false, status: 401 });
  });

  it('rejects a disallowed Origin — CSWSH defense (403)', async () => {
    const { cookie, tenantId } = await login();
    const canvasId = await makeDoc(tenantId);
    expect(await connect(canvasId, { cookie, origin: 'http://evil.test' })).toEqual({ open: false, status: 403 });
  });

  it('rejects another tenant\'s canvas — uniform 404 (no cross-tenant join)', async () => {
    const a = await login();
    const canvasId = await makeDoc(a.tenantId);
    const b = await login();
    expect(await connect(canvasId, { cookie: b.cookie, origin: ORIGIN })).toEqual({ open: false, status: 404 });
  });

  it('rejects a canvas whose type is NOT collab-registered — uniform 404 (ADR 0359 registry, fail-closed)', async () => {
    // Phase 5 registered all six FIRST-PARTY types, so the unregistered case is
    // now a pack-like type id — exactly the v1 exclusion the registry encodes.
    const { cookie, tenantId } = await login();
    const packish = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.packlike-checklist', name: 'X', initialState: { title: 'X', items: [] } });
    expect(await connect(packish.canvasId, { cookie, origin: ORIGIN })).toEqual({ open: false, status: 404 });
  });

  it('rejects when the canvas TYPE\'s own toggle is OFF despite realtime-collab ON — 404 (ADR 0359 HIGH-1)', async () => {
    const de = getToggleDefault('document-editor');
    if (de) await saveConfig({ ...de, status: 'off' }, 'test');
    try {
      const { cookie, tenantId } = await login();
      const canvasId = await makeDoc(tenantId);
      expect(await connect(canvasId, { cookie, origin: ORIGIN })).toEqual({ open: false, status: 404 });
    } finally {
      if (de) await saveConfig({ ...de, status: 'on' }, 'test');
    }
  });

  it('upgrades a SECOND registered collab type when both toggles are on (ADR 0359 generalization)', async () => {
    // Drawings registered at boot (Phase 5 rollout — re-registering here would
    // OVERWRITE its Phase 6 shape); just enable its own toggle — the transport
    // must serve it with no type pin.
    const dr = getToggleDefault('drawings');
    if (dr) await saveConfig({ ...dr, status: 'on' }, 'test');
    const { cookie, tenantId } = await login();
    const drawing = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'X', initialState: { title: 'X', shapes: [] } });
    expect(await connect(drawing.canvasId, { cookie, origin: ORIGIN })).toEqual({ open: true });
  });

  it('rejects when the realtime-collab toggle is OFF (404 — advertises nothing)', async () => {
    const collab = getToggleDefault('realtime-collab');
    if (collab) await saveConfig({ ...collab, status: 'off' }, 'test');
    try {
      const { cookie, tenantId } = await login();
      const canvasId = await makeDoc(tenantId);
      expect(await connect(canvasId, { cookie, origin: ORIGIN })).toEqual({ open: false, status: 404 });
    } finally {
      if (collab) await saveConfig({ ...collab, status: 'on' }, 'test');
    }
  });
});

describe('collab-capable type registry parity (ADR 0359 Phase 5)', () => {
  // The FE twin lives in frontend/react/src/canvas/__tests__/collabTypes.test.ts —
  // both sides pin the SAME first-party registrations (drift = a socket that
  // 404s a provisioning chassis, or a chassis that never provisions).
  it('boot registered every first-party canvas type with its OWN toggle', () => {
    expect(collabCanvasType('canvas.document')).toMatchObject({ canvasTypeId: 'canvas.document', toggleId: 'document-editor' });
    expect(collabCanvasType('canvas.slides')).toMatchObject({ canvasTypeId: 'canvas.slides', toggleId: 'slides' });
    expect(collabCanvasType('canvas.drawing')).toMatchObject({ canvasTypeId: 'canvas.drawing', toggleId: 'drawings' });
    expect(collabCanvasType('canvas.cad')).toMatchObject({ canvasTypeId: 'canvas.cad', toggleId: 'cad' });
    expect(collabCanvasType('canvas.campaign')).toMatchObject({ canvasTypeId: 'canvas.campaign', toggleId: 'campaign-studio' });
    expect(collabCanvasType('canvas.app-builder')).toMatchObject({ canvasTypeId: 'canvas.app-builder', toggleId: 'app-builder' });
    // ADR 0458 §2.3 — the challenge-outline authoring canvas rides the existing
    // `kicktodo-creator` toggle (a deliberate deviation from per-type toggles).
    expect(collabCanvasType('canvas.challenge-outline')).toMatchObject({ canvasTypeId: 'canvas.challenge-outline', toggleId: 'kicktodo-creator' });
    // Pack/unknown types are ABSENT — the fail-closed v1 exclusion.
    expect(collabCanvasType('canvas.some-pack-type')).toBeUndefined();
  });
});

describe('collab WS ticket auth (ADR 0359 correction — cross-origin prod posture)', () => {
  async function mintTicket(cookie: string, canvasId: string): Promise<{ status: number; ticket?: string }> {
    const res = await fetch(`${BASE}/v1/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}/ticket`, {
      method: 'POST', headers: { cookie },
    });
    if (!res.ok) return { status: res.status };
    return { status: res.status, ticket: ((await res.json()) as { ticket: string }).ticket };
  }

  it('mints over the cookie-authed route and upgrades WITHOUT a cookie (the cross-origin posture)', async () => {
    const { cookie, tenantId } = await login();
    const canvasId = await makeDoc(tenantId);
    const minted = await mintTicket(cookie, canvasId);
    expect(minted.status).toBe(200);
    expect(await connect(canvasId, { origin: ORIGIN }, `?ticket=${encodeURIComponent(minted.ticket!)}`)).toEqual({ open: true });
  });

  it('mint is uniform-404 on another tenant\'s canvas (no existence leak)', async () => {
    const a = await login();
    const canvasId = await makeDoc(a.tenantId);
    const b = await login();
    expect((await mintTicket(b.cookie, canvasId)).status).toBe(404);
  });

  it('rejects a ticket bound to a DIFFERENT canvas — 404 not a cross-canvas key', async () => {
    const { cookie, tenantId } = await login();
    const c1 = await makeDoc(tenantId);
    const c2 = await makeDoc(tenantId);
    const minted = await mintTicket(cookie, c1);
    // Valid signature, wrong canvas ⇒ ticket auth fails ⇒ no cookie ⇒ 401.
    expect(await connect(c2, { origin: ORIGIN }, `?ticket=${encodeURIComponent(minted.ticket!)}`)).toEqual({ open: false, status: 401 });
  });

  it('rejects an EXPIRED ticket (401) and a TAMPERED one', async () => {
    const { cookie, tenantId } = await login();
    const canvasId = await makeDoc(tenantId);
    const stale = mintCollabTicket(tenantId, canvasId, Date.now() - 3 * 60 * 60 * 1000);
    expect(verifyCollabTicket(stale, canvasId)).toBeNull();
    expect(await connect(canvasId, { origin: ORIGIN }, `?ticket=${encodeURIComponent(stale)}`)).toEqual({ open: false, status: 401 });
    const good = (await mintTicket(cookie, canvasId)).ticket!;
    const tampered = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(await connect(canvasId, { origin: ORIGIN }, `?ticket=${encodeURIComponent(tampered)}`)).toEqual({ open: false, status: 401 });
  });

  it('a session cookie can never replay as a ticket (the reverse direction)', async () => {
    const { cookie, tenantId } = await login();
    const canvasId = await makeDoc(tenantId);
    // The raw __session VALUE passed as ?ticket= must fail ticket verification
    // (distinct HMAC audience) and, with no cookie on the upgrade, land 401.
    const sessionValue = decodeURIComponent(cookie.split('=')[1]!);
    expect(verifyCollabTicket(sessionValue, canvasId)).toBeNull();
    expect(await connect(canvasId, { origin: ORIGIN }, `?ticket=${encodeURIComponent(sessionValue)}`)).toEqual({ open: false, status: 401 });
  });

  it('carries optional principal attribution through mint→verify', () => {
    const t = mintCollabTicket('org:x', 'c1', Date.now(), 'user:abc');
    expect(verifyCollabTicket(t, 'c1')).toEqual({ tenantId: 'org:x', principalId: 'user:abc' });
    const bare = mintCollabTicket('org:x', 'c1');
    expect(verifyCollabTicket(bare, 'c1')).toEqual({ tenantId: 'org:x' });
  });

  it('a ticket can never replay as a session cookie (distinct HMAC audience)', async () => {
    const { cookie, tenantId } = await login();
    const canvasId = await makeDoc(tenantId);
    const minted = await mintTicket(cookie, canvasId);
    // The signature verifies only under the ticket audience — as a session
    // cookie it is garbage (the middleware falls back to a fresh ANON session,
    // so over HTTP the probe surfaces as the uniform 404, never the tenant's).
    expect(verifySession(minted.ticket!)).toBeNull();
    const res = await fetch(`${BASE}/v1/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}/ticket`, {
      method: 'POST', headers: { cookie: `__session=${encodeURIComponent(minted.ticket!)}` },
    });
    expect(res.status).toBe(404);
  });
});
