/**
 * ADR 0335 Phase 2b — the collab seeder-election. The insert-if-absent CAS elects
 * exactly one seeder per canvas; the claim-seed HTTP verb is toggle-gated +
 * tenant-scoped (uniform 404 on a cross-tenant / wrong-type / disabled canvas).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { claimCollabSeed, __resetCollabSeedClaims } from '../src/host/collab/collabServer.js';
import { fireCanvasDeleted } from '../src/host/canvasLifecycle.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const c = getToggleDefault('realtime-collab'); if (c) await saveConfig({ ...c, status: 'on' }, 'test');
  const de = getToggleDefault('document-editor'); if (de) await saveConfig({ ...de, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => __resetCollabSeedClaims());

describe('claimCollabSeed (CAS election)', () => {
  it('elects exactly one seeder per canvas', async () => {
    expect(await claimCollabSeed('t1', 'cA', 'u1')).toBe(true);   // first wins
    expect(await claimCollabSeed('t1', 'cA', 'u2')).toBe(false);  // already claimed
    expect(await claimCollabSeed('t1', 'cB', 'u1')).toBe(true);   // different canvas
    expect(await claimCollabSeed('t2', 'cA', 'u1')).toBe(true);   // different tenant
  });
});

let n = 0;
async function login(): Promise<{ cookie: string; tenantId: string }> {
  const tenantId = `org:seed-${Date.now()}-${n++}`;
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `seed-${Date.now()}-${n++}@a.test`, tenantId }) });
  let cookie = ''; for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
  return { cookie, tenantId };
}
const claim = (cookie: string, canvasId: string) => fetch(`${BASE}/v1/host/openwop-app/canvas-collab/${canvasId}/claim-seed`, { method: 'POST', headers: { cookie } });

describe('claim-seed route', () => {
  it('returns seed:true to the first claimant, seed:false after (toggle-gated, tenant-scoped)', async () => {
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
    const r1 = await claim(cookie, canvas.canvasId); expect(r1.status).toBe(200); expect(((await r1.json()) as { seed: boolean }).seed).toBe(true);
    const r2 = await claim(cookie, canvas.canvasId); expect(((await r2.json()) as { seed: boolean }).seed).toBe(false);
  });

  it('404s a cross-tenant canvas', async () => {
    const a = await login();
    const canvas = await createCanvasForTenant(a.tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
    const b = await login();
    expect((await claim(b.cookie, canvas.canvasId)).status).toBe(404);
  });

  it('prunes the seed claim on canvas delete — the collab surface is re-claimable (data hygiene)', async () => {
    const { tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u2')).toBe(false); // taken
    await fireCanvasDeleted({ tenantId, canvasId: canvas.canvasId, canvasTypeId: 'canvas.document' });
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u3')).toBe(true);  // pruned → re-claimable
  });

  it('404s when the realtime-collab toggle is OFF', async () => {
    const c = getToggleDefault('realtime-collab'); if (c) await saveConfig({ ...c, status: 'off' }, 'test');
    try {
      const { cookie, tenantId } = await login();
      const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
      expect((await claim(cookie, canvas.canvasId)).status).toBe(404);
    } finally { if (c) await saveConfig({ ...c, status: 'on' }, 'test'); }
  });

  it('404s when the canvas TYPE\'s own toggle is OFF despite realtime-collab ON (ADR 0359 HIGH-1)', async () => {
    const de = getToggleDefault('document-editor'); if (de) await saveConfig({ ...de, status: 'off' }, 'test');
    try {
      const { cookie, tenantId } = await login();
      const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
      expect((await claim(cookie, canvas.canvasId)).status).toBe(404);
    } finally { if (de) await saveConfig({ ...de, status: 'on' }, 'test'); }
  });
});
