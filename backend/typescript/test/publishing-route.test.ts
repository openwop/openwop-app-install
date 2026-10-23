/**
 * Publishing & SEO (ADR 0012) — ROUTE-level harness. Boots the real app and
 * drives both surfaces: the AUTHED per-page SEO CRUD (RBAC-gated) and the
 * PUBLIC, unauthenticated published-site surface (page-by-slug, sitemap, robots,
 * feed) — including the toggle gate that takes the site offline and the
 * published-only / noindex rules.
 *
 * The SEO write is a DOUBLE GUARD on a published page: the `workspace:write`
 * scope gate AND the ADR 0836 D6 live-tier gate (admin). A viewer is refused by
 * the first; with the first removed the second still refuses, so round 1's
 * scope probe was vacuous (8fw1g3-pubr-rbac). The RBAC case now pins WHICH gate
 * answered (no `live_tier` reason) and adds a DRAFT page, where the scope gate
 * is the only one (8fw1g3-pubr-rbac-r2).
 *
 * Also sabotage-witnessed: the canonical-URL refusal (pubr-canonical-r2, now
 * asserting the field), noindex kept out of the sitemap (pubr-noindex-sitemap-r2,
 * with an indexable positive control) and the nav (pubr-noindex-nav),
 * X-Forwarded-Host sanitising (pubr-xfh) and the description fallback
 * (pubr-desc). Responses are typed at each call site.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'cms', 'publishing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; text: string; contentType: string }
interface Client {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  put: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  snapshot: () => string;
}
interface SeoBody { seo: { metaTitle?: string; ogImageToken?: string; noindex?: boolean } | null }
interface ErrBody { error: string; message: string; details?: Record<string, unknown> }
interface PublicPageBody { title: string; seo: { title: string; description: string; canonicalUrl: string } }
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const sc = getSetCookies(res.headers);
    for (const ck of sc as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const contentType = res.headers.get('content-type') ?? '';
    const text = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, text, contentType };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b),
    snapshot: () => cookie,
  };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('pub'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
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
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, org.text).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, add.text).toBe(201);
  return { owner, member, orgId };
}

/** Create a page and publish it (owner has host:members:manage → direct publish). */
async function publishedPage(owner: Client, orgId: string, title: string): Promise<{ pageId: string; slug: string }> {
  const cms = (s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
  const created = await owner.post<{ pageId: string; slug: string }>(cms('/pages'), { title, sections: [{ type: 'hero', data: { heading: 'Hello', subheading: 'A subheading used as the description fallback.' } }] });
  expect(created.status, created.text).toBe(201);
  const { pageId, slug } = created.body;
  const pub = await owner.post(cms(`/pages/${pageId}/publish`));
  expect(pub.status, pub.text).toBe(200);
  return { pageId, slug };
}

const seoUrl = (orgId: string, pageId: string): string => `/host/openwop-app/publishing/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(pageId)}/seo`;
const pub = (orgId: string, s: string): string => `/host/openwop-app/public/${encodeURIComponent(orgId)}${s}`;

describe('publishing — authed SEO CRUD (RBAC)', () => {
  it('owner sets + reads SEO; viewer reads but cannot write (403)', async () => {
    const { owner, member, orgId } = await ownerWithMember('viewer');
    const { pageId } = await publishedPage(owner, orgId, 'About Us');

    const put = await owner.put<SeoBody>(seoUrl(orgId, pageId), { metaTitle: 'About Acme', metaDescription: 'Who we are', noindex: false });
    expect(put.status, put.text).toBe(200);
    expect(put.body.seo?.metaTitle).toBe('About Acme');

    expect((await member.get<SeoBody>(seoUrl(orgId, pageId))).body.seo?.metaTitle).toBe('About Acme');
    // Published page: the SCOPE gate answers (no live-tier reason), and nothing landed.
    const denied = await member.put<ErrBody>(seoUrl(orgId, pageId), { metaTitle: 'nope' });
    expect(denied.status, denied.text).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');
    expect(denied.body.details?.reason).toBeUndefined();
    expect((await owner.get<SeoBody>(seoUrl(orgId, pageId))).body.seo?.metaTitle).toBe('About Acme');

    // DRAFT page: the live-tier gate does not apply, so the scope gate is the
    // ONLY thing between a viewer and the write.
    const draft = await owner.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title: 'Draft About' });
    expect(draft.status, draft.text).toBe(201);
    const draftDenied = await member.put<ErrBody>(seoUrl(orgId, draft.body.pageId), { metaTitle: 'nope' });
    expect(draftDenied.status, draftDenied.text).toBe(403);
    expect(draftDenied.body.error).toBe('forbidden_scope');
    expect((await owner.get<SeoBody>(seoUrl(orgId, draft.body.pageId))).body.seo?.metaTitle).toBeUndefined();
  });

  it('rejects a dangerous canonical URL and a page not in the org', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { pageId } = await publishedPage(owner, orgId, 'Pricing');
    const bad = await owner.put<ErrBody>(seoUrl(orgId, pageId), { canonicalUrl: 'javascript:alert(1)' });
    expect(bad.status, bad.text).toBe(400);
    expect(bad.body.error).toBe('validation_error');
    expect(bad.body.details?.field).toBe('canonicalUrl');
    // A REAL page in a SECOND org of the same tenant is not reachable through org 1.
    const org2 = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Other Co' });
    expect(org2.status, org2.text).toBe(201);
    const foreign = await publishedPage(owner, org2.body.orgId, 'Foreign Page');
    expect((await owner.get<SeoBody>(seoUrl(org2.body.orgId, foreign.pageId))).status).toBe(200); // positive control
    const cross = await owner.get<ErrBody>(seoUrl(orgId, foreign.pageId));
    expect(cross.status, cross.text).toBe(404);
    expect(cross.body.message).toBe('Page not found.');
  });

  it('treats a whitespace-only ogImageToken as cleared (not a 400)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { pageId } = await publishedPage(owner, orgId, 'Whitespace');
    const put = await owner.put<SeoBody>(seoUrl(orgId, pageId), { ogImageToken: '   ', metaTitle: 'X' });
    expect(put.status, put.text).toBe(200);
    expect(put.body.seo?.metaTitle).toBe('X'); // the write landed
    expect(put.body.seo?.ogImageToken).toBeUndefined();
  });
});

describe('publishing — public surface (unauthenticated)', () => {
  it('serves a published page by slug to an anonymous visitor, with merged SEO', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const { pageId, slug } = await publishedPage(owner, orgId, 'Welcome Home');
    await owner.put(seoUrl(orgId, pageId), { metaTitle: 'Welcome', metaDescription: 'The home page.' });

    const anon = client(); // NO cookie — public surface skips auth
    const r = await anon.get<PublicPageBody>(pub(orgId, `/pages/${slug}`));
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
    const r = await anon.get<PublicPageBody>(pub(orgId, `/pages/${slug}`));
    expect(r.status).toBe(200);
    expect(r.body.seo.description).toBe('A subheading used as the description fallback.');
  });

  it('404s a draft (published-only) and an unknown slug', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const cms = (s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
    const draft = await owner.post<{ slug: string }>(cms('/pages'), { title: 'Secret Draft' });
    expect(draft.status, draft.text).toBe(201);
    expect(draft.body.slug).toBe('secret-draft'); // the draft really exists under this slug
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

  it('nav list (ADR 0486): lists published pages (slug + title), EXCLUDES noindex pages', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const anon = client();
    const shown = await publishedPage(owner, orgId, 'Company');
    const hidden = await publishedPage(owner, orgId, 'Secret Landing');
    // A `noindex` page is kept out of the sitemap; it MUST likewise stay out of
    // the PRIMARY visible menu (a more prominent surface than the sitemap).
    const seo = await owner.put(seoUrl(orgId, hidden.pageId), { noindex: true });
    expect(seo.status, seo.text).toBe(200);

    const res = await anon.get<{ pages: Array<{ slug: string; title: string }> }>(pub(orgId, '/pages'));
    expect(res.status).toBe(200);
    const pages = res.body.pages;
    const slugs = pages.map((p) => p.slug);
    expect(slugs).toContain(shown.slug);
    expect(slugs).not.toContain(hidden.slug);            // noindex → hidden from the menu
    expect(pages.every((p) => p.slug && p.title)).toBe(true);
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
    const shown = await publishedPage(owner, orgId, 'Indexed Page');
    const put = await owner.put(seoUrl(orgId, pageId), { noindex: true });
    expect(put.status, put.text).toBe(200);
    const anon = client();
    const sitemap = await anon.get(pub(orgId, '/sitemap.xml'));
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toContain(`/pages/${shown.slug}<`); // positive control: indexable page listed
    expect(sitemap.text).not.toContain(`/pages/${slug}<`);
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
    const cms = `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pageId}/unpublish`;
    expect((await owner.post(cms)).status).toBe(200);
    expect((await anon.get(pub(orgId, `/pages/${slug}`))).status).toBe(404);
  });
});
