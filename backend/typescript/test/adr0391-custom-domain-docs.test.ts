/**
 * ADR 0391 — custom-domain document mapping for the blog + pricing surfaces:
 *  - `/blog` on a bound host → the blog-INDEX prerender (a semantic post list);
 *  - `/blog/:slug` → the page prerender (posts ARE CMS pages);
 *  - `/pricing` → the page prerender for the `pricing` slug;
 *  - unknown slugs → uniform 404; every mapping is GET-served and org-pinned.
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

const cms = (orgId: string, sfx = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${sfx}`;

/** An org (bound to a custom host) with a published post + a `pricing` page. */
async function boundSite(): Promise<{ orgId: string; host: string; postSlug: string }> {
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `cd-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Domain Co' });
  const orgId = org.body.orgId as string;

  const post = await owner.post(cms(orgId, '/pages'), {
    title: 'Launch Notes', kind: 'post', sections: [{ type: 'hero', data: { heading: 'Launch Notes', subheading: 'Our launch story.' } }],
  });
  expect((await owner.post(cms(orgId, `/pages/${post.body.pageId}/publish`))).status).toBe(200);

  const pricing = await owner.post(cms(orgId, '/pages'), {
    title: 'Pricing', sections: [{ type: 'hero', data: { heading: 'Pricing', subheading: 'Plans for every team.' } }],
  });
  expect(pricing.body.slug).toBe('pricing');
  expect((await owner.post(cms(orgId, `/pages/${pricing.body.pageId}/publish`))).status).toBe(200);

  await __resetCustomDomains();
  const host = `site-${n}.example.com`;
  const d = await addDomain({ tenantId: 't-any', orgId, createdBy: 'u', hostname: host });
  await verifyDomain('t-any', orgId, host, async () => [[d.verificationToken]]);
  invalidateHostCache();
  return { orgId, host, postSlug: post.body.slug as string };
}

describe('ADR 0391 — custom-domain blog + pricing mapping', () => {
  it('/blog serves the blog-index prerender (a semantic post list with links)', async () => {
    const { host, postSlug } = await boundSite();
    const res = await rawGet('/blog', { host, 'user-agent': 'GPTBot/1.0' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Launch Notes');
    expect(res.body).toContain(`/blog/${postSlug}`); // post link
  });

  it('/blog/:slug serves the post page prerender (posts are CMS pages)', async () => {
    const { host, postSlug } = await boundSite();
    const res = await rawGet(`/blog/${postSlug}`, { host, 'user-agent': 'Mozilla/5.0 Safari' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<h1>Launch Notes</h1>');
  });

  it('/pricing serves the `pricing` page prerender', async () => {
    const { host } = await boundSite();
    const res = await rawGet('/pricing', { host, 'user-agent': 'GPTBot/1.0' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<h1>Pricing</h1>');
  });

  it('an unknown blog slug is a uniform 404', async () => {
    const { host } = await boundSite();
    expect((await rawGet('/blog/no-such-post', { host })).status).toBe(404);
  });

  it('the blog-index prerender route is also reachable directly (platform origin)', async () => {
    const { orgId, postSlug } = await boundSite();
    const res = await rawGet(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/blog/prerender`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Launch Notes');
    expect(res.body).toContain(`/blog/${postSlug}`);
  });
});
