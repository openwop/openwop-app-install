/**
 * ADR 0310 Phase C — drawings/cad/campaign-studio editor routes. The factory
 * mechanics (versions, restore, idempotent seed) are pinned by the slides and
 * app-builder suites; this pins the PER-TYPE bindings: each type's toggle
 * gate, canvas-type pin, validator wiring (422 on schema violations), a clean
 * save round-trip, and delete.
 *
 * Tracker TST-CXE-1. Red when a type's route config drops its `validate`
 * (drawings/cad/campaign-studio routes.ts — the invalid save is accepted) or
 * the factory's type pin is removed (canvasEditorRoutes.ts `loadCanvas` — a
 * slides canvas is readable through this type's routes).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The fields these cases read from the editor routes' JSON bodies. */
interface Body { orgId?: string; canvasTypeId?: string; components?: unknown[]; newVersion?: number; error?: string; message?: string }
interface Res { status: number; body: Body }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: Body = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function orgOwner(): Promise<{ c: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:test-el-ed-${Date.now()}-${n++}`;
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `eled-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId ?? '', tenantId };
}

const CASES = [
  {
    id: 'drawings',
    toggle: 'drawings',
    base: (orgId: string) => `/host/openwop-app/drawings/orgs/${encodeURIComponent(orgId)}`,
    canvasTypeId: 'canvas.drawing',
    valid: { title: 'Scene', width: 400, height: 300, shapes: [{ kind: 'rect', x: 10, y: 10, width: 50, height: 40, fill: 'tomato' }] },
    invalid: { title: 'Scene', shapes: [{ kind: 'blob' }] },
    invalid2: { title: 'Scene', shapes: [{ kind: 'rect', script: 'alert(1)' }] },
  },
  {
    id: 'cad',
    toggle: 'cad',
    base: (orgId: string) => `/host/openwop-app/cad/orgs/${encodeURIComponent(orgId)}`,
    canvasTypeId: 'canvas.cad',
    valid: { name: 'Bracket', units: 'mm', solids: [{ kind: 'box', x: 0, y: 0, z: 0, width: 40, height: 30, depth: 20 }] },
    invalid: { name: 'Bracket', solids: [{ kind: 'torus' }] },
    invalid2: { name: 'Bracket', units: 'furlongs', solids: [{ kind: 'box' }] },
  },
  {
    id: 'campaign-studio',
    toggle: 'campaign-studio',
    base: (orgId: string) => `/host/openwop-app/campaign-studio/orgs/${encodeURIComponent(orgId)}`,
    canvasTypeId: 'canvas.campaign',
    valid: { name: 'Launch', objective: 'Grow', channels: [{ name: 'Newsletter', type: 'email', budget: 100 }], funnel: [{ stage: 'awareness', kpis: ['reach'] }], assets: [{ headline: 'Hi', cta: 'Go' }] },
    invalid: { name: 'Launch', channels: [{ name: 'X', type: 'carrier-pigeon' }] },
    invalid2: { name: 'Launch', channels: [{ name: 'X', type: 'email' }], funnel: [{ stage: 'awareness', kpis: Array.from({ length: 9 }, (_, i) => `k${i}`) }] },
  },
] as const;

describe.each(CASES)('$id editor routes (ADR 0310 Phase C)', (tc) => {
  it('is toggle-gated (404 off), type-pinned, validates (422), saves, and deletes', async () => {
    const { c, orgId, tenantId } = await orgOwner();

    // Canvas types default ON (2026-07-09) — set off explicitly to test the gate,
    // and restore ON in finally so a failure cannot leak OFF into later rows.
    const d = getToggleDefault(tc.toggle);
    expect(d, tc.toggle).toBeTruthy();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: tc.canvasTypeId, name: 'D', initialState: tc.valid });
    try {
      await saveConfig({ ...d!, status: 'off' }, 'test');
      // Toggle off → uniform 404.
      const off = await c.get(`${tc.base(orgId)}/canvases/${canvas.canvasId}`);
      expect(off.status).toBe(404);
      expect(off.body.error).toBe('not_found');
    } finally {
      await saveConfig({ ...d!, status: 'on' }, 'test');
    }

    // Catalog serves (empty component list — no catalog registered for the type).
    const cat = await c.get(`${tc.base(orgId)}/catalog`);
    expect(cat.status).toBe(200);
    expect(cat.body.canvasTypeId).toBe(tc.canvasTypeId);
    expect(cat.body.components).toEqual([]);

    // Wrong-type pin: a slides canvas is a uniform 404 on this type's routes.
    const foreign = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', name: 'S', initialState: { title: 'S', slides: [{ layout: 'title' }] } });
    const foreignRead = await c.get(`${tc.base(orgId)}/canvases/${foreign.canvasId}`);
    expect(foreignRead.status).toBe(404);
    // The envelope redacts the high-entropy id (errorEnvelope sanitizer).
    expect(foreignRead.body).toMatchObject({ error: 'not_found', message: "canvas '<redacted:high-entropy>' not found" });

    // Validator wiring: schema violations reject with 422 from the catalog validator.
    for (const state of [tc.invalid, tc.invalid2]) {
      const bad = await c.patch(`${tc.base(orgId)}/canvases/${canvas.canvasId}`, { state, expectedVersion: 1 });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toBe('validation_error');
      expect(bad.body.message).toMatch(/^canvas state violates the component catalog: /);
    }

    // Clean save round-trip + optimistic concurrency + delete.
    const save = await c.patch(`${tc.base(orgId)}/canvases/${canvas.canvasId}`, { state: tc.valid, expectedVersion: 1 });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(save.body.newVersion).toBe(2);
    const stale = await c.patch(`${tc.base(orgId)}/canvases/${canvas.canvasId}`, { state: tc.valid, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/^canvas \S+ version conflict: expected 1, have 2$/);
    expect((await c.del(`${tc.base(orgId)}/canvases/${canvas.canvasId}`)).status).toBe(204);
    const gone = await c.get(`${tc.base(orgId)}/canvases/${canvas.canvasId}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('not_found');
  });
});
