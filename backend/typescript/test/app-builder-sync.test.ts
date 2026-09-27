/**
 * ADR 0393 Lane A — sync-binding + sync routes, ROUTE-level: the `code-sync`
 * toggle gate (OFF by default), the `host:code-sync:manage` admin gate on
 * bind/unbind (an editor holds workspace:write but must 403), the
 * secret-returns-once contract, bind validation, and the no-connection 424 on
 * the push path (governance: the token is only reachable through the broker).
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
  for (const id of ['users', 'app-builder']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const setSyncToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('code-sync');
  if (d) await saveConfig({ ...d, status }, 'test');
};

const STATE = { name: 'S', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'text', props: { text: 'x' } }] }] };
const AB = (orgId: string) => `/v1/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}`;
const BIND = { owner: 'octo', repo: 'my-app', branch: 'main', target: 'html-css' };

async function ownerEditorCanvas(): Promise<{ owner: Client; editor: Client; orgId: string; canvasId: string }> {
  const tenantId = `org:test-ab-sync-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `own-${Date.now()}-${n++}@acme.test`, tenantId });
  const editor = client();
  const editorUser = (await editor.post('/v1/host/openwop-app/test/login', { email: `ed-${Date.now()}-${n++}@acme.test`, tenantId })).body.user;
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.body.orgId)}/members`, { displayName: 'Ed', subject: editorUser.userId, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'S', initialState: STATE });
  return { owner, editor, orgId: org.body.orgId, canvasId: canvas.canvasId };
}

describe('code-sync toggle gate', () => {
  it('404s the binding surface until code-sync is enabled (OFF by default)', async () => {
    await setSyncToggle('off');
    const { owner, orgId, canvasId } = await ownerEditorCanvas();
    expect((await owner.put(`${AB(orgId)}/canvases/${canvasId}/sync-binding`, BIND)).status).toBe(404);
    await setSyncToggle('on');
    expect((await owner.get(`${AB(orgId)}/canvases/${canvasId}/sync-binding`)).status).toBe(200);
  });
});

describe('binding RBAC (host:code-sync:manage) + contract', () => {
  it('owner binds (secret returned exactly once); editor reads but cannot bind/unbind', async () => {
    await setSyncToggle('on');
    const { owner, editor, orgId, canvasId } = await ownerEditorCanvas();

    // editor holds workspace:write — NOT enough to wire an external write channel
    expect((await editor.put(`${AB(orgId)}/canvases/${canvasId}/sync-binding`, BIND)).status).toBe(403);

    const bound = await owner.put(`${AB(orgId)}/canvases/${canvasId}/sync-binding`, BIND);
    expect(bound.status, JSON.stringify(bound.body)).toBe(201);
    expect(typeof bound.body.webhookSecret).toBe('string');
    expect(bound.body.binding.owner).toBe('octo');
    expect(JSON.stringify(bound.body.binding)).not.toContain(bound.body.webhookSecret);

    // reads never carry the secret, and editors may read
    const read = await editor.get(`${AB(orgId)}/canvases/${canvasId}/sync-binding`);
    expect(read.status).toBe(200);
    expect(read.body.binding.repo).toBe('my-app');
    expect(JSON.stringify(read.body)).not.toContain(bound.body.webhookSecret);

    // one binding per canvas (single active branch)
    expect((await owner.put(`${AB(orgId)}/canvases/${canvasId}/sync-binding`, BIND)).status).toBe(409);

    // unbind: editor 403, owner 204, second unbind 404
    expect((await editor.del(`${AB(orgId)}/canvases/${canvasId}/sync-binding`)).status).toBe(403);
    expect((await owner.del(`${AB(orgId)}/canvases/${canvasId}/sync-binding`)).status).toBe(204);
    expect((await owner.del(`${AB(orgId)}/canvases/${canvasId}/sync-binding`)).status).toBe(404);
  });

  it('validates owner/repo/branch/target at the bind boundary (typed 400s)', async () => {
    await setSyncToggle('on');
    const { owner, orgId, canvasId } = await ownerEditorCanvas();
    const p = `${AB(orgId)}/canvases/${canvasId}/sync-binding`;
    expect((await owner.put(p, { ...BIND, owner: '-bad-' })).status).toBe(400);
    expect((await owner.put(p, { ...BIND, repo: 'no spaces' })).status).toBe(400);
    expect((await owner.put(p, { ...BIND, branch: 'bad..ref' })).status).toBe(400);
    expect((await owner.put(p, { ...BIND, target: 'cobol' })).status).toBe(400);
  });
});

describe('sync push route', () => {
  it('409s without a binding; with one, fails 424 when no GitHub connection exists (broker-only token reach)', async () => {
    await setSyncToggle('on');
    const { owner, editor, orgId, canvasId } = await ownerEditorCanvas();
    expect((await owner.post(`${AB(orgId)}/canvases/${canvasId}/sync`)).status).toBe(409);
    expect((await owner.put(`${AB(orgId)}/canvases/${canvasId}/sync-binding`, BIND)).status).toBe(201);
    // editor MAY push (workspace:write) — the admin-gated binding fixed the destination
    const pushed = await editor.post(`${AB(orgId)}/canvases/${canvasId}/sync`);
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(424);
    expect(String(pushed.body.message)).toContain('GitHub');
  });
});
