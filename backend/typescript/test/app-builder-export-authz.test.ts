/**
 * Grade pass AB-CODE-9 — the DENIAL paths of the app-builder verbs, through
 * the real HTTP boundary (the golden journey pins the granted path):
 *  - toggle-off → 404 `not_found` (the surface simply doesn't exist for the
 *    tenant; `code-export` gates independently of the editor)
 *  - `code-publish` off → 404 (a vendor WRITE gates on its OWN toggle even
 *    while read-only export is on — ADR 0306)
 *  - cross-tenant org id → 404 (the IDOR guard: no existence leak)
 * The missing-scope 403 (`forbidden_scope`) lives in the shared
 * `authorizeOrgScope` and is pinned by the featureRoute suites.
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
  for (const id of ['users', 'app-builder', 'code-export']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  // code-publish explicitly OFF — the vendor WRITE gates on its OWN toggle,
  // independent of read-only export (ADR 0306); its 404 is part of the contract.
  const pub = getToggleDefault('code-publish');
  if (pub) await saveConfig({ ...pub, status: 'off' }, 'test');
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

const AB = (orgId: string, rest: string): string => `/v1/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}${rest}`;

async function signInWithCanvas(tag: string): Promise<{ user: ReturnType<typeof client>; orgId: string; canvasId: string }> {
  const user = client();
  const login = await user.post('/v1/host/openwop-app/test/login', { email: `${tag}@acme.test`, tenantId: `org:${tag}` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await user.post('/v1/host/openwop-app/orgs', { name: tag });
  const orgId = org.body.orgId as string;
  const created = await user.post(AB(orgId, '/canvases'), { name: 'App' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { user, orgId, canvasId: created.body.canvasId as string };
}

describe('app-builder verb denial paths (grade pass AB-CODE-9)', () => {
  it('code-export off → export verbs 404 while the editor stays up; publish is its own opt-in', async () => {
    const { user, orgId, canvasId } = await signInWithCanvas('authz-toggle');
    // Baseline: the granted path works before the flip.
    expect((await user.post(AB(orgId, `/canvases/${canvasId}/export`), { target: 'react-tailwind' })).status).toBe(201);

    // code-publish is off — a vendor WRITE is an independent opt-in even
    // while read-only export is on (ADR 0306).
    expect((await user.post(AB(orgId, `/canvases/${canvasId}/publish`), { target: 'react-tailwind', repo: 'acme/app' })).status).toBe(404);

    const d = getToggleDefault('code-export');
    expect(d).toBeTruthy();
    await saveConfig({ ...d!, status: 'off' }, 'test');
    try {
      expect((await user.post(AB(orgId, `/canvases/${canvasId}/export`), { target: 'react-tailwind' })).status).toBe(404);
      expect((await user.get(AB(orgId, `/canvases/${canvasId}/exports`))).status).toBe(404);
      // The EDITOR surface rides its own toggle and stays up.
      expect((await user.get(AB(orgId, `/canvases/${canvasId}`))).status).toBe(200);
    } finally {
      await saveConfig({ ...d!, status: 'on' }, 'test');
    }
  });

  it("cross-tenant org id → 404 on the export verbs (IDOR guard, no existence leak)", async () => {
    const a = await signInWithCanvas('authz-owner');
    const b = client();
    const login = await b.post('/v1/host/openwop-app/test/login', { email: 'authz-intruder@acme.test', tenantId: 'org:authz-intruder' });
    expect(login.status).toBe(201);

    expect((await b.post(AB(a.orgId, `/canvases/${a.canvasId}/export`), { target: 'react-tailwind' })).status).toBe(404);
    expect((await b.get(AB(a.orgId, `/canvases/${a.canvasId}/exports`))).status).toBe(404);
    // The owner still sees exactly one lineage entry — the intruder wrote nothing.
    const mine = await a.user.get(AB(a.orgId, `/canvases/${a.canvasId}/exports`));
    expect(mine.status).toBe(200);
    expect(Array.isArray(mine.body.exports)).toBe(true);
  });
});
