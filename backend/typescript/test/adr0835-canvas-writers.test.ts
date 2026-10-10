/**
 * ADR 0835 D3 + D7 — the two canvas writers that skipped the editor's checks.
 *
 *  - S3 (from-artifact): a run artifact is model output. Its schema leaves
 *    component props open, so a payload the editor would refuse became a
 *    durable app-builder canvas — and the stored-canvas export then shipped
 *    it. The route also seeded whatever canvas type the artifact named, so an
 *    app-builder artifact posted to the SLIDES door became an app-builder
 *    canvas past app-builder's own toggle and authorize.
 *  - S9 (ui-plugin `artifact.write`): gated by READ visibility only, and
 *    written without `validateAppDoc` — a Viewer overwrote canvases.
 *
 * Each refusal sits beside a control that must still succeed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant, getCanvasForTenant } from '../src/host/canvasSurface.js';
import { persistRunArtifact } from '../src/host/runArtifactStore.js';
import { dispatcherForTenant } from '../src/routes/uiPlugins.js';
import { UI_PLUGIN_PROTOCOL } from '../src/host/uiPluginRpc.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['app-builder', 'slides']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client(): { post: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    },
  };
}

const H = '/host/openwop-app';
const AB = (orgId: string) => `${H}/app-builder/orgs/${encodeURIComponent(orgId)}`;
const SL = (orgId: string) => `${H}/slides/orgs/${encodeURIComponent(orgId)}`;
const HOSTILE = 'md"><script>alert(document.domain)</script><p class="';
const app = (fontSize = 'md') => ({ name: 'Todo', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'text', props: { text: 'hi', fontSize } }] }] });

async function fixture() {
  const tenantId = `org:writers835-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId: string = (await owner.post(`${H}/test/login`, { email: `w835-o-${n++}@acme.test`, tenantId })).body.user.userId;
  const viewer = client();
  const viewerId: string = (await viewer.post(`${H}/test/login`, { email: `w835-v-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId: string = (await owner.post(`${H}/orgs`, { name: 'Acme' })).body.orgId;
  const add = await owner.post(`${H}/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { tenantId, owner, ownerId, viewerId, orgId };
}

async function emit(tenantId: string, payload: unknown, artifactTypeId = 'canvas.app-builder'): Promise<string> {
  const runId = `run-835-${Date.now()}-${n++}`;
  await persistRunArtifact({ tenantId, runId, nodeId: 'render', role: 'deliverable', now: new Date().toISOString(), output: { artifact: { artifactTypeId, payload, title: 'Todo' } } });
  return `${runId}:render`;
}

describe('ADR 0835 D3 — from-artifact is type-pinned and closed-world (S3)', () => {
  it('refuses an artifact whose design the editor would refuse (422 + errors), and seeds a valid one', async () => {
    const f = await fixture();
    const bad = await f.owner.post(`${AB(f.orgId)}/canvases/from-artifact`, { artifactKey: await emit(f.tenantId, app(HOSTILE)) });
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    const good = await f.owner.post(`${AB(f.orgId)}/canvases/from-artifact`, { artifactKey: await emit(f.tenantId, app()) });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    expect(good.body.canvasTypeId).toBe('canvas.app-builder');
  });

  it('an app-builder artifact is absent to the slides door (uniform 404)', async () => {
    const f = await fixture();
    const res = await f.owner.post(`${SL(f.orgId)}/canvases/from-artifact`, { artifactKey: await emit(f.tenantId, app()) });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });
});

const rpc = (id: number, method: string, params: unknown) => ({ openwop: UI_PLUGIN_PROTOCOL, id, type: 'request', method, params });

describe('ADR 0835 D7 — the ui-plugin write is the editor write (S9)', () => {
  it('a Viewer who can read a canvas cannot overwrite it', async () => {
    const f = await fixture();
    const c = await createCanvasForTenant(f.tenantId, { canvasTypeId: 'canvas.app-builder', name: 'Org app', initialState: app() as never });
    const read = await dispatcherForTenant(f.tenantId, { subject: f.viewerId })(rpc(1, 'artifact.read', { artifactId: c.canvasId }));
    expect(read?.ok, 'control: the viewer CAN read it').toBe(true);
    const write = await dispatcherForTenant(f.tenantId, { subject: f.viewerId })(rpc(2, 'artifact.write', { artifactId: c.canvasId, version: '1', payload: app() }));
    expect(write).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect((await getCanvasForTenant(f.tenantId, c.canvasId))!.version).toBe(1);
  });

  it('an out-of-catalog payload is refused, a valid one from an editor-class member lands', async () => {
    const f = await fixture();
    const c = await createCanvasForTenant(f.tenantId, { canvasTypeId: 'canvas.app-builder', name: 'Org app', initialState: app() as never });
    const bad = await dispatcherForTenant(f.tenantId, { subject: f.ownerId })(rpc(1, 'artifact.write', { artifactId: c.canvasId, version: '1', payload: app(HOSTILE) }));
    expect(bad?.ok).toBe(false);
    expect((await getCanvasForTenant(f.tenantId, c.canvasId))!.version).toBe(1);
    const good = await dispatcherForTenant(f.tenantId, { subject: f.ownerId })(rpc(2, 'artifact.write', { artifactId: c.canvasId, version: '1', payload: app('lg') }));
    expect(good?.ok, JSON.stringify(good)).toBe(true);
  });
});
