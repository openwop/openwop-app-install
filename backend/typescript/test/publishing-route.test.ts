/**
 * Publishing & SEO (ADR 0012) — ROUTE-level harness. Boots the real app and
 * drives both surfaces: the AUTHED per-page SEO CRUD (RBAC-gated) and the
 * PUBLIC, unauthenticated published-site surface (page-by-slug, sitemap, robots,
 * feed) — including the toggle gate that takes the site offline and the
 * published-only / noindex rules.
 */

import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18693;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  for (const id of ['users', 'cms', 'publishing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T; text: string; contentType: string }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; snapshot: () => string }
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const sc = getSetCookies(res.headers);
    for (const ck of sc as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const contentType = res.headers.get('content-type') ?? '';
    const text = res.status === 204 ? '' : await res.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text, contentType };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), snapshot: () => cookie };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pub'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, r.text).toBe(201);
  return r.body.user;
}
async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  // Co-tenant owner + member: mint each into one shared explicit tenantId.
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, org.text).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, add.text).toBe(201);
  return { owner, member, orgId };
}

/** Create a page and publish it (owner has host:members:manage → direct publish). */
async function publishedPage(owner: Client, orgId: string, title: string): Promise<{ pageId: string; slug: string }> {
  const cms = (s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
  const created = await owner.post(cms('/pages'), { title, sections: [{ type: 'hero', data: { heading: 'Hello', subheading: 'A subheading used as the description fallback.' } }] });
  expect(created.status, created.text).toBe(201);
  const { pageId, slug } = created.body;
  const pub = await owner.post(cms(`/pages/${pageId}/publish`));
  expect(pub.status, pub.text).toBe(200);
  return { pageId, slug };
}

const seoUrl = (orgId: string, pageId: string): string => `/v1/host/openwop-app/publishing/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(pageId)}/seo`;
const pub = (orgId: string, s: string): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}${s}`;

describe('publishing — authed SEO CRUD (RBAC)', () => {
  it('owner sets + reads SEO; viewer reads but cannot write (403)', async () => {
    const { owner, member, orgId } = await ownerWithMember('viewer');
    const { pageId } = await publishedPage(owner, orgId, 'About Us');

    const put = await owner.put(seoUrl(orgId, pageId), { metaTitle: 'About Acme', metaDescription: 'Who we are', noindex: false });
    expect(put.status, put.text).toBe(200);
    expect(put.body.seo.metaTitle).toBe('About Acme');

    expect((await member.get(seoUrl(orgId, pageId))).body.seo.metaTitle).toBe('About Acme');
    expect((await member.put(seoUrl(orgId, pageId), { metaTitle: 'nope' })).status).toBe(403);
  });

  it('rejects a dangerous canonical URL and a page not in the org', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { pageId } = await publishedPage(owner, orgId, 'Pricing');
    expect((await owner.put(seoUrl(orgId, pageId), { canonicalUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await owner.get(seoUrl(orgId, 'no-such-page'))).status).toBe(404);
  });

  it('treats a whitespace-only ogImageToken as cleared (not a 400)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { pageId } = await publishedPage(owner, orgId, 'Whitespace');
    const put = await owner.put(seoUrl(orgId, pageId), { ogImageToken: '   ', metaTitle: 'X' });
    expect(put.status, put.text).toBe(200);
    expect(put.body.seo.ogImageToken).toBeUndefined();
  });
});

describe('publishing — public surface (unauthenticated)', () => {
  it('serves a published page by slug to an anonymous visitor, with merged SEO', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { pageId, slug } = await publishedPage(owner, orgId, 'Welcome Home');
    await owner.put(seoUrl(orgId, pageId), { metaTitle: 'Welcome', metaDescription: 'The home page.' });

    const anon = client(); // NO cookie — public surface skips auth
    const r = await anon.get(pub(orgId, `/pages/${slug}`));
    expect(r.status, r.text).toBe(200);
    expect(r.body.title).toBe('Welcome Home');
    expect(r.body.seo.title).toBe('Welcome');
    expect(r.body.seo.description).toBe('The home page.');
    expect(r.body.seo.canonicalUrl).toContain(`/public/${orgId}/pages/${slug}`);
  });

  it('falls back to page content for description when SEO is unset', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { slug } = await publishedPage(owner, orgId, 'No Seo Page');
    const anon = client();
    const r = await anon.get(pub(orgId, `/pages/${slug}`));
    expect(r.status).toBe(200);
    expect(r.body.seo.description).toBe('A subheading used as the description fallback.');
  });

  it('404s a draft (published-only) and an unknown slug', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const cms = (s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
    const draft = await owner.post(cms('/pages'), { title: 'Secret Draft' });
    const anon = client();
    expect((await anon.get(pub(orgId, `/pages/${draft.body.slug}`))).status).toBe(404);
    expect((await anon.get(pub(orgId, '/pages/does-not-exist'))).status).toBe(404);
  });

  it('emits sitemap.xml, robots.txt, and feed.rss', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { slug } = await publishedPage(owner, orgId, 'Blog Post One');
    const anon = client();

    const sitemap = await anon.get(pub(orgId, '/sitemap.xml'));
    expect(sitemap.status).toBe(200);
    expect(sitemap.contentType).toContain('xml');
    expect(sitemap.text).toContain(`/public/${orgId}/pages/${slug}`);
    expect(sitemap.text).toContain('<urlset');

    const robots = await anon.get(pub(orgId, '/robots.txt'));
    expect(robots.status).toBe(200);
    expect(robots.contentType).toContain('text/plain');
    expect(robots.text).toContain('Sitemap:');
    expect(robots.text).toContain(`/public/${orgId}/sitemap.xml`);

    const feed = await anon.get(pub(orgId, '/feed.rss'));
    expect(feed.status).toBe(200);
    expect(feed.contentType).toContain('rss');
    expect(feed.text).toContain('<rss');
    expect(feed.text).toContain('Blog Post One');
  });

  it('sanitizes an attacker-influenced X-Forwarded-Host (no injection into sitemap)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    await publishedPage(owner, orgId, 'Host Test');
    // A header value with chars valid in HTTP but NOT in a host — the sitemap must
    // strip them, not reflect them into the generated absolute URL.
    const res = await fetch(`${BASE}${pub(orgId, '/sitemap.xml')}`, { headers: { 'x-forwarded-host': 'evil.com|inject' } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('evil.com|inject');
    expect(text).toContain('evil.cominject'); // the sanitized host
  });

  it('excludes a noindex page from the sitemap', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { pageId, slug } = await publishedPage(owner, orgId, 'Hidden Page');
    await owner.put(seoUrl(orgId, pageId), { noindex: true });
    const anon = client();
    const sitemap = await anon.get(pub(orgId, '/sitemap.xml'));
    expect(sitemap.text).not.toContain(`/pages/${slug}`);
  });

  it('is always-on (ADR 0027): the per-page `published` status is the public gate, not a toggle', async () => {
    // ADR 0027 overturns ADR 0012 Alt 4: there is no `publishing` toggle, and the
    // public surface is never gated by one. Publishing a page makes it public;
    // UNPUBLISHING it (back to draft) takes that page offline. Sharing (ADR 0013)
    // covers private/draft access.
    expect(getToggleDefault('publishing')).toBeNull();
    const { owner, orgId } = await ownerWithMember('viewer');
    const { pageId, slug } = await publishedPage(owner, orgId, 'Live Page');
    const anon = client();
    expect((await anon.get(pub(orgId, `/pages/${slug}`))).status).toBe(200);
    // The public distribution surface (sitemap/robots/feed) serves without a toggle.
    expect((await anon.get(pub(orgId, '/robots.txt'))).status).toBe(200);

    // Unpublish the page → it (and only it) leaves the public surface.
    const cms = `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pageId}/unpublish`;
    expect((await owner.post(cms)).status).toBe(200);
    expect((await anon.get(pub(orgId, `/pages/${slug}`))).status).toBe(404);
  });
});
