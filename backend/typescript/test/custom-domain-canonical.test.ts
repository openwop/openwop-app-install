/**
 * ADR 0391 (custom-domain public site) / ADR 0384 (prerender canonical + JSON-LD),
 * fix b28d02e77 — a custom-domain page names its OWN address, not the app's.
 *
 * Served on a bound custom domain, the page prerender, the blog index and the
 * podcast pages put the domain into the canonical link, `og:url`, hreflang and the
 * JSON-LD site URLs, at the paths that domain serves (`/`, `/pricing`, `/p/:slug`,
 * `/blog`, `/blog/:slug`). This file asserts canonical, `og:url` and the JSON-LD site
 * URL; hreflang (emitted only for a multi-locale page) is NOT asserted here. Before this, every custom-domain page told search
 * engines its canonical address was the internal
 * `https://app…/host/openwop-app/public/<org>/pages/<slug>`, so a tenant's site was
 * filed as a duplicate of an app URL (seen live on openwop.davidtufts.me).
 *
 *   1. home, a plain page, `/pricing` and a post carry the domain's URL;
 *   2. the blog index's canonical is the domain's `/blog`;
 *   3. a canonical the author set is kept;
 *   4. the same page on the platform origin keeps the app URL, and the two never
 *      share a cached document, in either render order.
 *
 * Podcast pages are covered in adr0390-podcast-prerender.test.ts.
 *
 * Sabotage, measured by probe (w87): not passing the bound origin from the page
 * route reds 1 and 4; dropping it from the blog route reds 2; replacing an author's
 * canonical reds 3; leaving the origin out of the prerender cache key reds 4 (both
 * orders); JSON-LD built on the platform base, or `/pricing` or a post mapped to
 * `/p/<slug>`, reds 1; the middleware not recording the verified hostname reds 1, 2
 * and 4.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { addDomain, verifyDomain, invalidateHostCache, __resetCustomDomains } from '../src/host/customDomains.js';

let BASE: string; let PORT = 0; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  for (const id of ['users', 'custom-domains']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_SEO_PRERENDER_DISABLED; });

interface Res<T> { status: number; body: T }
interface OrgBody { orgId: string }
interface LoginBody { user: { tenantId: string } }
interface PageBody { pageId: string; slug: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  };
  return { post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b) };
}

function rawGet(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}


const cms = (orgId: string, sfx = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${sfx}`;
const canonicalOf = (html: string): string => /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1] ?? '';
const ogUrlOf = (html: string): string => /<meta property="og:url" content="([^"]+)">/.exec(html)?.[1] ?? '';

async function site(): Promise<{ orgId: string; host: string; post: string; pages: Record<string, string>; owner: ReturnType<typeof client> }> {
  const owner = client();
  const login = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `canon-${n++}@acme.test` });
  expect(login.status).toBe(201);
  const tenantId = login.body.user.tenantId;
  const orgId = (await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Canon Co' })).body.orgId;
  const pages: Record<string, string> = {};
  for (const title of ['Home', 'About', 'Pricing']) {
    const p = await owner.post<PageBody>(cms(orgId, '/pages'), { title, sections: [{ type: 'hero', data: { heading: title } }] });
    expect((await owner.post(cms(orgId, `/pages/${p.body.pageId}/publish`))).status).toBe(200);
    pages[p.body.slug] = p.body.pageId;
  }
  const post = await owner.post<PageBody>(cms(orgId, '/pages'), { title: 'Launch Notes', kind: 'post', sections: [{ type: 'hero', data: { heading: 'Launch Notes' } }] });
  expect((await owner.post(cms(orgId, `/pages/${post.body.pageId}/publish`))).status).toBe(200);
  await __resetCustomDomains();
  const host = `canon-${n}.example.com`;
  // Bound to the org owner's own tenant, as the add-domain route does.
  const d = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: host });
  await verifyDomain(tenantId, orgId, host, async () => [[d.verificationToken]]);
  invalidateHostCache();
  return { orgId, host, post: post.body.slug, pages, owner };
}

const BOT = { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' };

describe('a custom-domain page names its own address', () => {
  it('home, a plain page, /pricing and a post carry the domain URL in canonical, og:url and JSON-LD', async () => {
    const s = await site();
    const origin = `https://${s.host}`;
    const cases: Array<[string, string]> = [['/', `${origin}/`], ['/p/about', `${origin}/p/about`], ['/pricing', `${origin}/pricing`], [`/blog/${s.post}`, `${origin}/blog/${s.post}`]];
    for (const [path, want] of cases) {
      const r = await rawGet(path, { host: s.host, ...BOT });
      expect(r.status, path).toBe(200);
      expect(canonicalOf(r.body), path).toBe(want);
      expect(ogUrlOf(r.body), path).toBe(want);
      expect(r.body, path).toContain(`"url":"${origin}"`);
      expect(r.body, path).not.toContain('/host/openwop-app/public/');
    }
  });

  it("the blog index's canonical is the domain's /blog", async () => {
    const s = await site();
    const r = await rawGet('/blog', { host: s.host, ...BOT });
    expect(r.status).toBe(200);
    expect(canonicalOf(r.body)).toBe(`https://${s.host}/blog`);
    expect(ogUrlOf(r.body)).toBe(`https://${s.host}/blog`);
  });

  it('keeps a canonical the author set', async () => {
    const s = await site();
    const put = await s.owner.put(`/host/openwop-app/publishing/orgs/${encodeURIComponent(s.orgId)}/pages/${s.pages.about}/seo`, { canonicalUrl: 'https://elsewhere.example.org/about' });
    expect(put.status).toBe(200);
    const r = await rawGet('/p/about', { host: s.host, ...BOT });
    expect(canonicalOf(r.body)).toBe('https://elsewhere.example.org/about');
  });

  it('the platform origin keeps the app URL, and the two never share a cached document', async () => {
    // The prerender HTML cache is used only when the base URL is configured.
    const prev = process.env.OPENWOP_PUBLIC_BASE_URL;
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.test';
    try {
      const s = await site();
      const direct = `/host/openwop-app/public/${encodeURIComponent(s.orgId)}/prerender/about`;
      // Platform first (about), then domain first (pricing, rendered by nothing
      // before): whichever renders first must not be served to the other.
      const a1 = await rawGet(direct, BOT);
      const b1 = await rawGet('/p/about', { host: s.host, ...BOT });
      const a2 = await rawGet(direct, BOT);
      expect(a1.status).toBe(200);
      expect(canonicalOf(a1.body)).toBe(`https://app.example.test/host/openwop-app/public/${encodeURIComponent(s.orgId)}/pages/about`);
      expect(canonicalOf(a2.body)).toBe(canonicalOf(a1.body));
      expect(canonicalOf(b1.body)).toBe(`https://${s.host}/p/about`);
      const c1 = await rawGet('/pricing', { host: s.host, ...BOT });
      const d1 = await rawGet(`/host/openwop-app/public/${encodeURIComponent(s.orgId)}/prerender/pricing`, BOT);
      expect(c1.status).toBe(200);
      expect(d1.status).toBe(200);
      expect(canonicalOf(c1.body)).toBe(`https://${s.host}/pricing`);
      expect(canonicalOf(d1.body)).toBe(`https://app.example.test/host/openwop-app/public/${encodeURIComponent(s.orgId)}/pages/pricing`);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL; else process.env.OPENWOP_PUBLIC_BASE_URL = prev;
    }
  });
});
