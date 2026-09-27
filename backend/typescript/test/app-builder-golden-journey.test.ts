/**
 * ADR 0342 Phase 8 (OP-07) — the GOLDEN JOURNEY, end-to-end through the real
 * HTTP boundary: blank canvas → the comprehensive ADR 0343 document (facets,
 * actions, bindings, sharePolicy) saved through the editor gate → kit
 * availability on the catalog → export with preflight + in-bundle OpenAPI +
 * sha256 lineage (ADR 0348) → the exports history → the SANITIZED public
 * share (ADR 0345 3a) → version history. One user story, every program seam.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'app-builder', 'code-export', 'sharing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}

const AB = (orgId: string, rest: string): string => `/v1/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}${rest}`;

describe('the golden journey (ADR 0342 §Phase 8 / OP-07)', () => {
  it('blank → comprehensive doc → kits → export(preflight+openapi+lineage) → history → sanitized share', async () => {
    // 1. Sign in + org.
    const user = client();
    const login = await user.post('/v1/host/openwop-app/test/login', { email: `gj-${Date.now()}@acme.test`, tenantId: `org:gj-${Date.now()}` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Golden' });
    const orgId = org.body.orgId as string;

    // 2. A blank app-builder canvas (the ADR 0314 creation path).
    const created = await user.post(AB(orgId, '/canvases'), { name: 'Golden App' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const canvasId = created.body.canvasId as string;

    // 3. The catalog carries the pack kit (ADR 0347 5a).
    const catalog = await user.get(AB(orgId, '/catalog'));
    expect(catalog.status).toBe(200);
    expect((catalog.body.kits ?? []).map((k: { kitId: string }) => k.kitId)).toContain('app-builder.auth-flow');

    // 4. Save the COMPREHENSIVE document through the editor gate (ADR 0343).
    const doc = {
      name: 'Golden App',
      theme: 'dark',
      themeColors: { primary: '#7c5cff', secondary: '#22d3ee' },
      stateVariables: [{ id: 'filter', type: 'string', initial: 'all' }],
      models: [{ id: 'task', name: 'Task', fields: [{ name: 'title', type: 'string', required: true }] }],
      operations: [{ id: 'listTasks', name: 'List tasks', kind: 'list', modelId: 'task', output: { type: 'modelList' }, mock: { status: 'ok', rows: [{ title: 'Ship it' }] } }],
      sharePolicy: { sampleData: 'redact' },
      dataSources: [{ id: 'seed', name: 'Seed', fields: ['email'], rows: [{ email: 'real.person@example.com' }] }],
      screens: [
        {
          id: 'home', name: 'Home', route: '/home', isInitial: true, x: 80, y: 80,
          components: [
            { type: 'text', props: { text: 'placeholder' }, bindings: { text: { path: 'state.filter' } } },
            { type: 'button', props: { label: 'Load' }, actions: [{ on: 'click', kind: 'invoke-operation', operation: 'listTasks' }] },
            { type: 'list', props: { bind: 'seed' }, children: [{ type: 'text', props: { text: '{{email}}' } }] },
          ],
        },
      ],
      connectors: [],
    };
    const saved = await user.patch(AB(orgId, `/canvases/${canvasId}`), { state: doc, expectedVersion: created.body.version ?? 1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // The editor gate rejects a hard violation (closed world).
    const bad = await user.patch(AB(orgId, `/canvases/${canvasId}`), { state: { ...doc, screens: [{ id: 'x', name: 'X', components: [{ type: 'holo-deck' }] }] } });
    expect(bad.status).toBe(422);

    // 5. Export: preflight names what the target drops; openapi ships; hash returned (ADR 0348).
    const exp = await user.post(AB(orgId, `/canvases/${canvasId}/export`), { target: 'react-tailwind' });
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    expect(exp.body.hash).toMatch(/^[0-9a-f]{64}$/);
    const preflightCodes = (exp.body.preflight as { code: string }[]).map((n) => n.code);
    expect(preflightCodes).toContain('actions_not_generated');
    expect(preflightCodes).toContain('operations_not_generated');
    const dl = await fetch(`${BASE}${exp.body.serveUrl}`);
    expect(dl.status).toBe(200);
    // strict mode refuses to drop declared semantics.
    expect((await user.post(AB(orgId, `/canvases/${canvasId}/export`), { target: 'react-tailwind', strict: true })).status).toBe(422);

    // 6. The exports history records the lineage (ADR 0348 6c).
    const lineage = await user.get(AB(orgId, `/canvases/${canvasId}/exports`));
    expect(lineage.status).toBe(200);
    expect(lineage.body.exports).toHaveLength(1);
    expect(lineage.body.exports[0]).toMatchObject({ target: 'react-tailwind', hash: exp.body.hash });

    // 7. Version history captured the save (ADR 0305 E).
    const versions = await user.get(AB(orgId, `/canvases/${canvasId}/versions`));
    expect(versions.status).toBe(200);
    expect((versions.body.versions ?? versions.body ?? []).length).toBeGreaterThan(0);

    // 8. The public share serves the SANITIZED projection (ADR 0345 3a).
    const link = await user.post(`/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`, { resourceType: 'app_builder_canvas', resourceId: canvasId });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const shared = await fetch(`${BASE}/v1/host/openwop-app/shared/${link.body.token}`);
    expect(shared.status).toBe(200);
    const sharedBody = await shared.json() as { resource: { app: Record<string, unknown> } };
    const app = sharedBody.resource.app;
    expect(JSON.stringify(app)).not.toContain('real.person@example.com'); // rows redacted
    expect(app.operations).toBeUndefined();
    expect(app.envRequirements).toBeUndefined();
    expect(app.sharePolicy).toBeUndefined();
    expect((app.dataSources as { id: string; fields?: string[] }[])[0]).toMatchObject({ id: 'seed' }); // shape kept
    expect(app.themeColors).toEqual({ primary: '#7c5cff', secondary: '#22d3ee' }); // render-sufficient kept
  }, 30000);
});
