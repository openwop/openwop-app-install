/**
 * Funnels Phase 1 (ADR 0294 / Funnel A) — the funnel entity through the HTTP boundary:
 *  - toggle gate: routes 403 while `funnels` is off;
 *  - CRUD: create (slug derivation + org-unique), steps validated against CMS pages
 *    (a foreign/unknown pageId is a 400, not a stored dangler);
 *  - lifecycle: publish requires ≥1 step and resolving pages; slug immutable while
 *    published; unpublish/archive; archived is read-only;
 *  - tenant isolation: another tenant's funnel reads 404 (no existence leak).
 *
 * TST-DEB-4 — red when a refusal (slug clash, foreign step page, slug lock,
 * archived edit, empty/deleted-page publish) is dropped, or either isolation
 * guard is removed. Isolation is a DOUBLE GUARD, and each half has its own leg:
 *  - OUTER: `requireOrgScope` → `assertOrgScope` refuses an org outside the
 *    caller's tenant ("Organization not found.") — the cross-tenant stranger;
 *  - INNER: `getFunnel`'s `tenantId`/`orgId` row fence — reached by the OWNER
 *    asking for org A's funnel through their own org B path ("Funnel not found.").
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

interface Res<T> { status: number; body: T }
interface FunnelBody { funnel: { funnelId: string; slug: string; status: string; publishedAt?: string; steps: unknown[] } }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const text = res.status === 204 ? '' : await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
}

/** The exact refusal: status, envelope code and message (two 400s share a code). */
function refused(r: Res<unknown>, status: number, error: string, message: string): void {
  expect(r.status).toBe(status);
  expect(r.body).toMatchObject({ error, message });
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string }> {
  const user = client();
  await user.post('/host/openwop-app/test/login', { email: `fun-${Date.now()}-${n++}@acme.test` });
  const org = await user.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Funnel Co' });
  expect(org.status).toBe(201);
  return { user, orgId: org.body.orgId };
}

const f = (orgId: string, suffix = ''): string => `/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels${suffix}`;

async function makePage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<string> {
  const r = await user.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  expect(r.status).toBe(201);
  return r.body.pageId; // cms create returns the page object directly
}

describe('funnels Phase 1 — entity + lifecycle over HTTP', () => {
  it('full lifecycle: create → steps → publish → slug lock → unpublish → archive → delete', async () => {
    const { user, orgId } = await marketer();
    const landing = await makePage(user, orgId, 'Landing');
    const thanks = await makePage(user, orgId, 'Thanks');

    // create with slug derived from the name
    const created = await user.post<FunnelBody>(f(orgId), { name: 'Summer Launch!', steps: [{ kind: 'landing', pageId: landing }] });
    expect(created.status).toBe(201);
    const id = created.body.funnel.funnelId;
    expect(created.body.funnel.slug).toBe('summer-launch');
    expect(created.body.funnel.status).toBe('draft');

    // org-unique slug
    refused(await user.post(f(orgId), { name: 'Summer Launch' }), 400, 'validation_error', 'A funnel with slug "summer-launch" already exists.');

    // steps referencing a page outside the workspace are rejected
    refused(await user.patch(f(orgId, `/${id}`), { steps: [{ kind: 'landing', pageId: 'nope-not-a-page' }] }), 400, 'validation_error', 'Step page not found in this workspace: nope-not-a-page');

    // extend the path + publish
    const upd = await user.patch<FunnelBody>(f(orgId, `/${id}`), { steps: [{ kind: 'landing', pageId: landing }, { kind: 'thankyou', pageId: thanks }] });
    expect(upd.status).toBe(200);
    expect(upd.body.funnel.steps).toHaveLength(2);
    // ADR 1023 D7 (FN72WF-19) — a funnel whose step pages are drafts would go live
    // as a 404, so the direct publish refuses it (the approval lane's rule), and
    // publishing a funnel never publishes its pages. Sabotage-witnessed: dropping
    // `requirePublishedPages` from the route turns this red.
    const dark = await user.post<{ error?: { details?: { reason?: string } } }>(f(orgId, `/${id}/publish`));
    expect(dark.status).toBe(409);
    expect(JSON.stringify(dark.body)).toContain('step_pages_unpublished');
    for (const pageId of [landing, thanks]) {
      expect((await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pageId}/publish`)).status).toBe(200);
    }
    const pub = await user.post<FunnelBody>(f(orgId, `/${id}/publish`));
    expect(pub.status).toBe(200);
    expect(pub.body.funnel.status).toBe('published');
    expect(typeof pub.body.funnel.publishedAt).toBe('string');

    // slug immutable while published
    refused(await user.patch(f(orgId, `/${id}`), { slug: 'moved' }), 400, 'validation_error', 'Unpublish the funnel before changing its slug.');

    // unpublish → editable again; archive → read-only; delete
    const unpub = await user.post<FunnelBody>(f(orgId, `/${id}/unpublish`));
    expect(unpub.body.funnel.status).toBe('draft');
    const arch = await user.post<FunnelBody>(f(orgId, `/${id}/archive`));
    expect(arch.body.funnel.status).toBe('archived');
    refused(await user.patch(f(orgId, `/${id}`), { name: 'New name' }), 400, 'validation_error', 'An archived funnel cannot be edited.');
    const del = await user.del(f(orgId, `/${id}`));
    expect(del.status).toBe(200);
    refused(await user.get(f(orgId, `/${id}`)), 404, 'not_found', 'Funnel not found.');
  });

  it('publish refuses an empty funnel and a funnel whose step page was deleted', async () => {
    const { user, orgId } = await marketer();
    const empty = await user.post<FunnelBody>(f(orgId), { name: 'Empty' });
    refused(await user.post(f(orgId, `/${empty.body.funnel.funnelId}/publish`)), 400, 'validation_error', 'A funnel needs at least one step to publish.');

    const pageId = await makePage(user, orgId, 'Doomed');
    const withStep = await user.post<FunnelBody>(f(orgId), { name: 'Doomed funnel', steps: [{ kind: 'landing', pageId }] });
    const delPage = await user.del(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pageId}`);
    expect(delPage.status).toBe(204);
    // The page id is high-entropy, so the envelope scrubber redacts it — match the prefix.
    const doomed = await user.post(f(orgId, `/${withStep.body.funnel.funnelId}/publish`));
    expect(doomed.status).toBe(400);
    expect(doomed.body).toMatchObject({ error: 'validation_error', message: expect.stringMatching(/^Step page no longer exists: /) });
  });

  it('tenant isolation: a foreign tenant cannot see or mutate the funnel (404, no leak)', async () => {
    const { user, orgId } = await marketer();
    const pageId = await makePage(user, orgId, 'Mine');
    const created = await user.post<FunnelBody>(f(orgId), { name: 'Private', steps: [{ kind: 'landing', pageId }] });
    const id = created.body.funnel.funnelId;
    // Positive control: the owner reads it.
    expect((await user.get(f(orgId, `/${id}`))).status).toBe(200);

    // OUTER guard — a different tenant: the org gate refuses before any row read.
    const { user: stranger } = await marketer();
    refused(await stranger.get(f(orgId, `/${id}`)), 404, 'not_found', 'Organization not found.');
    refused(await stranger.patch(f(orgId, `/${id}`), { name: 'Hijack' }), 404, 'not_found', 'Organization not found.');

    // INNER guard — the owner's OWN second org passes the org gate, so only the
    // row fence stands between org B's path and org A's funnel.
    const orgB = await user.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Other Co' });
    expect(orgB.status).toBe(201);
    refused(await user.get(f(orgB.body.orgId, `/${id}`)), 404, 'not_found', 'Funnel not found.');
    const after = await user.get<FunnelBody & { funnel: { name: string } }>(f(orgId, `/${id}`));
    expect(after.body.funnel.name).toBe('Private');
  });

  it('toggle gate: routes deny while the funnels toggle is off', async () => {
    const d = getToggleDefault('funnels');
    expect(d).toBeTruthy();
    await saveConfig({ ...d!, status: 'off' }, 'test');
    try {
      const { user, orgId } = await marketer();
      refused(await user.get(f(orgId)), 404, 'not_found', 'Funnels is not enabled for this tenant.');
    } finally {
      await saveConfig({ ...d!, status: 'on' }, 'test');
    }
  });
});
