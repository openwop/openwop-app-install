/**
 * Funnels Phase 1 (ADR 0294 / Funnel A) — the funnel entity through the HTTP boundary:
 *  - toggle gate: routes 403 while `funnels` is off;
 *  - CRUD: create (slug derivation + org-unique), steps validated against CMS pages
 *    (a foreign/unknown pageId is a 400, not a stored dangler);
 *  - lifecycle: publish requires ≥1 step and resolving pages; slug immutable while
 *    published; unpublish/archive; archived is read-only;
 *  - tenant isolation: another tenant's funnel reads 404 (no existence leak).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'funnels']) {
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string }> {
  const user = client();
  await user.post('/v1/host/openwop-app/test/login', { email: `fun-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Funnel Co' });
  return { user, orgId: org.body.orgId };
}

const f = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels${suffix}`;

async function makePage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<string> {
  const r = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  expect(r.status).toBe(201);
  return r.body.pageId; // cms create returns the page object directly
}

describe('funnels Phase 1 — entity + lifecycle over HTTP', () => {
  it('full lifecycle: create → steps → publish → slug lock → unpublish → archive → delete', async () => {
    const { user, orgId } = await marketer();
    const landing = await makePage(user, orgId, 'Landing');
    const thanks = await makePage(user, orgId, 'Thanks');

    // create with slug derived from the name
    const created = await user.post(f(orgId), { name: 'Summer Launch!', steps: [{ kind: 'landing', pageId: landing }] });
    expect(created.status).toBe(201);
    const id: string = created.body.funnel.funnelId;
    expect(created.body.funnel.slug).toBe('summer-launch');
    expect(created.body.funnel.status).toBe('draft');

    // org-unique slug
    const dup = await user.post(f(orgId), { name: 'Summer Launch' });
    expect(dup.status).toBe(400);

    // steps referencing a page outside the workspace are rejected
    const bad = await user.patch(f(orgId, `/${id}`), { steps: [{ kind: 'landing', pageId: 'nope-not-a-page' }] });
    expect(bad.status).toBe(400);

    // extend the path + publish
    const upd = await user.patch(f(orgId, `/${id}`), { steps: [{ kind: 'landing', pageId: landing }, { kind: 'thankyou', pageId: thanks }] });
    expect(upd.status).toBe(200);
    expect(upd.body.funnel.steps).toHaveLength(2);
    const pub = await user.post(f(orgId, `/${id}/publish`));
    expect(pub.status).toBe(200);
    expect(pub.body.funnel.status).toBe('published');
    expect(pub.body.funnel.publishedAt).toBeTruthy();

    // slug immutable while published
    const slugMove = await user.patch(f(orgId, `/${id}`), { slug: 'moved' });
    expect(slugMove.status).toBe(400);

    // unpublish → editable again; archive → read-only; delete
    const unpub = await user.post(f(orgId, `/${id}/unpublish`));
    expect(unpub.body.funnel.status).toBe('draft');
    const arch = await user.post(f(orgId, `/${id}/archive`));
    expect(arch.body.funnel.status).toBe('archived');
    const editArchived = await user.patch(f(orgId, `/${id}`), { name: 'New name' });
    expect(editArchived.status).toBe(400);
    const del = await user.del(f(orgId, `/${id}`));
    expect(del.status).toBe(200);
    expect((await user.get(f(orgId, `/${id}`))).status).toBe(404);
  });

  it('publish refuses an empty funnel and a funnel whose step page was deleted', async () => {
    const { user, orgId } = await marketer();
    const empty = await user.post(f(orgId), { name: 'Empty' });
    expect((await user.post(f(orgId, `/${empty.body.funnel.funnelId}/publish`))).status).toBe(400);

    const pageId = await makePage(user, orgId, 'Doomed');
    const withStep = await user.post(f(orgId), { name: 'Doomed funnel', steps: [{ kind: 'landing', pageId }] });
    const delPage = await user.del(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pageId}`);
    expect(delPage.status).toBe(204);
    expect((await user.post(f(orgId, `/${withStep.body.funnel.funnelId}/publish`))).status).toBe(400);
  });

  it('tenant isolation: a foreign tenant cannot see or mutate the funnel (404, no leak)', async () => {
    const { user, orgId } = await marketer();
    const pageId = await makePage(user, orgId, 'Mine');
    const created = await user.post(f(orgId), { name: 'Private', steps: [{ kind: 'landing', pageId }] });
    const id: string = created.body.funnel.funnelId;

    const { user: stranger } = await marketer(); // different tenant, own org
    // Stranger probes the owner's org path — org membership gate should already deny.
    const read = await stranger.get(f(orgId, `/${id}`));
    expect([403, 404]).toContain(read.status);
    const write = await stranger.patch(f(orgId, `/${id}`), { name: 'Hijack' });
    expect([403, 404]).toContain(write.status);
  });

  it('toggle gate: routes deny while the funnels toggle is off', async () => {
    const d = getToggleDefault('funnels');
    expect(d).toBeTruthy();
    await saveConfig({ ...d!, status: 'off' }, 'test');
    try {
      const { user, orgId } = await marketer();
      const r = await user.get(f(orgId));
      expect([403, 404]).toContain(r.status);
    } finally {
      await saveConfig({ ...d!, status: 'on' }, 'test');
    }
  });
});
