/**
 * ADR 0305 Phase D — sharing an app-builder canvas rides the sharing seam:
 * `app_builder_canvas` ResourceType + resolver over `host.canvas`. ROUTE-level:
 * authed mint (workspace:write) → PUBLIC unauthenticated resolve → card →
 * cross-tenant 404 (no existence leak) → wrong-canvas-type 404 → revoke kills it.
 *
 * SABOTAGE-WITNESSED (grade-tests w7, probes `w7g1-shab-*`): dropping the
 * canvas-type pin or the canvas tenant check reds the 404 case; a wrong title in
 * `load` or `card` reds the resolve case. REVOKE has TWO guards on the content
 * path (`resolveActiveLink` AND `countShareViewOrThrow` both refuse a revoked
 * row), so the content-resolve 404 alone could not witness either (probe
 * shab-revoke was vacuous); the CARD path is uncounted and passes only
 * `resolveActiveLink`, so the post-revoke card 404 is what pins that gate.
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
  for (const id of ['users', 'sharing', 'app-builder']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface Client {
  get: <T = unknown>(p: string) => Promise<Res<T>>;
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = unknown>(p: string) => Promise<Res<T>>;
}
interface SharedCanvas { resourceType: string; resource: { kind: string; title: string; app: { screens: unknown[] } } }
interface LinkRow { resourceId: string }
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function orgOwner(): Promise<{ c: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:test-ab-share-${Date.now()}-${n++}`;
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `ab-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}

const APP_STATE = {
  name: 'Todo Board',
  description: 'Tiny sample',
  screens: [
    { id: 'home', name: 'Home', isInitial: true, components: [{ type: 'button', props: { label: 'Go', navigateTo: 'list' } }] },
    { id: 'list', name: 'List', components: [{ type: 'text', props: { text: 'Items' } }] },
  ],
};

describe('sharing an app-builder canvas (ADR 0305 Phase D)', () => {
  it('mints, resolves publicly (current state), serves the card, and revokes', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'Todo Board', initialState: APP_STATE });
    const mint = await c.post<{ token: string }>(`/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`, { resourceType: 'app_builder_canvas', resourceId: canvas.canvasId, expiresInDays: 7 });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    const token = mint.body.token;
    expect(token.length).toBeGreaterThan(20);

    // Public resolve — NO cookie.
    const anon = client();
    const shared = await anon.get<SharedCanvas>(`/host/openwop-app/shared/${encodeURIComponent(token)}`);
    expect(shared.status).toBe(200);
    expect(shared.body.resourceType).toBe('app_builder_canvas');
    expect(shared.body.resource.kind).toBe('app_builder_canvas');
    expect(shared.body.resource.title).toBe('Todo Board');
    expect(shared.body.resource.app.screens).toHaveLength(2);

    const card = await anon.get<{ title: string }>(`/host/openwop-app/shared/${encodeURIComponent(token)}/card`);
    expect(card.status).toBe(200);
    expect(card.body.title).toBe('Todo Board');

    const revoke = await c.del(`/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links/${encodeURIComponent(token)}`);
    expect(revoke.status, 'SHWF-13 — the route returns 204; accepting [200,204] pinned nothing').toBe(204);
    const gone = await anon.get(`/host/openwop-app/shared/${encodeURIComponent(token)}`);
    expect(gone.status).toBe(404);
    // The card path is uncounted, so it rests on `resolveActiveLink`'s revoked
    // check ALONE — this is the leg that can go red if that gate is dropped.
    const goneCard = await anon.get(`/host/openwop-app/shared/${encodeURIComponent(token)}/card`);
    expect(goneCard.status, 'a revoked link must not keep serving its social card').toBe(404);
  });

  it('mint 404s for a non-app-builder canvas type and for a cross-tenant canvas id', async () => {
    const a = await orgOwner();
    const slides = await createCanvasForTenant(a.tenantId, { canvasTypeId: 'canvas.slides', name: 'Deck', initialState: { title: 'Deck' } });
    const wrongType = await a.c.post<{ error: string }>(`/host/openwop-app/sharing/orgs/${encodeURIComponent(a.orgId)}/links`, { resourceType: 'app_builder_canvas', resourceId: slides.canvasId });
    expect(wrongType.status).toBe(404);
    expect(wrongType.body.error).toBe('not_found');

    const victim = await createCanvasForTenant(a.tenantId, { canvasTypeId: 'canvas.app-builder', name: 'Private', initialState: APP_STATE });
    const b = await orgOwner(); // different tenant
    const cross = await b.c.post<{ error: string }>(`/host/openwop-app/sharing/orgs/${encodeURIComponent(b.orgId)}/links`, { resourceType: 'app_builder_canvas', resourceId: victim.canvasId });
    expect(cross.status).toBe(404); // no existence leak
    expect(cross.body.error).toBe('not_found');

    // Neither refusal minted anything.
    for (const [who, orgId] of [[a.c, a.orgId], [b.c, b.orgId]] as const) {
      const list = await who.get<{ links: LinkRow[] }>(`/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`);
      expect(list.status).toBe(200);
      expect(list.body.links).toEqual([]);
    }
  });
});
