/**
 * ADR 1057 D1/D2 — `/docs` is crawlable, and the sitemap lists the docs.
 *
 * One real tenant + org (`getOrg` must resolve for every public lane), configured
 * as the public site org per case and unset again after. Pages are seeded in
 * `beforeAll`, so no case depends on another's writes.
 *
 * Red on `origin/main` `6f88c9047` (witnessed before the fix): no backend route
 * answered `/docs` or `/docs/:slug`, and `/docs` was not an auth-public path, so a
 * crawler got the SPA shell from Hosting (MEASURED live: the generic 7,503-byte
 * shell at every `/docs` URL) and this host answered 401. The sitemap dropped every
 * docs page (`publishingService.ts` `listPublishedWithSeo`). `/p/<docs slug>` served
 * crawlers a second copy whose canonical pointed at a URL that rendered nothing.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage, transitionPage, updatePage } from '../src/features/cms/cmsService.js';
import { isPublicPath } from '../src/middleware/auth.js';

let BASE = ''; let PORT = 0; let server: http.Server;
let TENANT = ''; let ORG = '';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const SHELL = '<!doctype html><html><head><title>shell</title></head><body><div id="root"></div></body></html>';
let shellFile = '';

async function setDocsToggle(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('docs');
  if (d) await saveConfig({ ...d, status }, 'test');
}

function rawGet(path: string, ua: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { 'user-agent': ua } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function publish(slug: string, title: string, docs: boolean): Promise<string> {
  const page = await createPage({ tenantId: TENANT, orgId: ORG, title, slug, ...(docs ? { collection: 'docs' as const, docsNav: `guides/${slug}` } : {}), sections: [{ type: 'richText', data: { heading: title, text: `${title} body text.` } }], createdBy: 'u1' });
  await transitionPage(TENANT, ORG, page.pageId, 'publish', 'u1');
  return page.pageId;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  for (const id of ['docs', 'users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  let cookie = '';
  const call = async (path: string, body: unknown): Promise<{ user?: { tenantId?: string }; tenantId?: string; orgId?: string }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return (await res.json()) as { user?: { tenantId?: string }; tenantId?: string; orgId?: string };
  };
  const login = await call('/host/openwop-app/test/login', { email: `docs1057-${Date.now()}@acme.test` });
  TENANT = login.user?.tenantId ?? login.tenantId ?? '';
  ORG = (await call('/host/openwop-app/orgs', { name: 'Crawlable Docs Co' })).orgId ?? '';
  expect(TENANT).not.toBe('');
  expect(ORG).not.toBe('');
  await publish('getting-started', 'Getting Started', true);
  await publish('configuration', 'Configuration', true);
  const renamed = await publish('old-name', 'Renamed Doc', true);
  await updatePage(TENANT, ORG, renamed, { slug: 'new-name' }, 'admin');
  await publish('pricing', 'Pricing', false);
  await publish('escaped', '<script>alert(1)</script> & Co', true);
  shellFile = join(mkdtempSync(join(tmpdir(), 'docs1057-')), 'shell.html');
  writeFileSync(shellFile, SHELL);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => {
  delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
  delete process.env.OPENWOP_SPA_SHELL_FILE;
  await setDocsToggle('on');
});
const asSite = (): void => { process.env.OPENWOP_PUBLIC_SITE_ORG_ID = ORG; process.env.OPENWOP_SPA_SHELL_FILE = shellFile; };

describe('D1 — the /docs doors', () => {
  it('`/docs` is an auth-public path (B1: the door would otherwise 401 every crawler)', () => {
    expect(isPublicPath('/docs')).toBe(true);
    expect(isPublicPath('/docs/getting-started')).toBe(true);
    expect(isPublicPath('/docsx')).toBe(false);
  });

  it('a crawler gets the docs page prerendered, with itself as the canonical', async () => {
    asSite();
    const r = await rawGet('/docs/getting-started', BOT);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<title>Getting Started');
    expect(r.body).toMatch(/<link rel="canonical" href="[^"]*\/docs\/getting-started">/);
    expect(r.body).toContain('Getting Started body text.');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(String(r.headers.vary)).toMatch(/User-Agent/i);
  });

  it('a crawler gets an honest 404 for an unknown slug and for a non-docs page', async () => {
    asSite();
    expect((await rawGet('/docs/does-not-exist', BOT)).status).toBe(404);
    expect((await rawGet('/docs/pricing', BOT)).status, '/docs must not serve a marketing page').toBe(404);
    expect((await rawGet('/docs/NOT_A_SLUG', BOT)).status).toBe(404);
  });

  it('one canonical spelling: case and trailing-slash variants 301 to /docs/<lowercase> (grade-ux N1)', async () => {
    asSite();
    for (const [from, to] of [['/docs/Getting-Started', '/docs/getting-started'], ['/docs/getting-started/', '/docs/getting-started'], ['/docs/', '/docs']] as const) {
      const r = await rawGet(from, BOT);
      expect(r.status, from).toBe(301);
      expect(r.headers.location, from).toBe(to);
    }
  });

  it('a nested path is a crawler 404', async () => {
    asSite();
    expect((await rawGet('/docs/a/b', BOT)).status).toBe(404);
  });

  it('the index escapes author text', async () => {
    asSite();
    const r = await rawGet('/docs', BOT);
    expect(r.body).not.toContain('<script>alert(1)</script>');
    expect(r.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
  });

  it('a renamed doc 301s a crawler to its new /docs URL', async () => {
    asSite();
    const r = await rawGet('/docs/old-name', BOT);
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('/docs/new-name');
  });

  it('the docs index is a crawlable list of every published doc', async () => {
    asSite();
    const r = await rawGet('/docs', BOT);
    expect(r.status).toBe(200);
    expect(r.body).toContain('href="/docs/getting-started"');
    expect(r.body).toContain('href="/docs/configuration"');
    expect(r.body).not.toContain('href="/docs/pricing"');
    expect(r.body).toMatch(/<link rel="canonical" href="[^"]*\/docs">/);
  });

  it('humans get the SPA shell on /docs, /docs/:slug and a nested path', async () => {
    asSite();
    for (const path of ['/docs', '/docs/getting-started', '/docs/a/b']) {
      const r = await rawGet(path, HUMAN);
      expect(r.status, path).toBe(200);
      expect(r.body, path).toBe(SHELL);
    }
  });

  it('with docs OFF a crawler gets 404 on /docs and /docs/:slug', async () => {
    asSite();
    await setDocsToggle('off');
    expect((await rawGet('/docs', BOT)).status).toBe(404);
    expect((await rawGet('/docs/getting-started', BOT)).status).toBe(404);
  });

  it('/p/<docs slug> sends a crawler to /docs (301), or 404s with docs OFF (M3)', async () => {
    asSite();
    const r = await rawGet('/p/getting-started', BOT);
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('/docs/getting-started');
    // A marketing page on /p is untouched.
    expect((await rawGet('/p/pricing', BOT)).status).toBe(200);
    await setDocsToggle('off');
    expect((await rawGet('/p/getting-started', BOT)).status).toBe(404);
  });
});

describe('D2 — the sitemap', () => {
  it('lists the site org\'s published docs at their /docs URLs, and drops them when docs is OFF', async () => {
    asSite();
    const on = await (await fetch(`${BASE}/sitemap.xml`)).text();
    expect(on).toMatch(/<loc>[^<]*\/docs\/getting-started<\/loc>/);
    expect(on).toMatch(/<loc>[^<]*\/docs\/new-name<\/loc>/);
    expect(on).toMatch(/<loc>[^<]*\/p\/pricing<\/loc>/);
    await setDocsToggle('off');
    const off = await (await fetch(`${BASE}/sitemap.xml`)).text();
    expect(off).not.toContain('/docs/');
    expect(off).toMatch(/<loc>[^<]*\/p\/pricing<\/loc>/);
  });

  it('a non-site org\'s per-org sitemap still lists no docs (no /docs door there)', async () => {
    const r = await (await fetch(`${BASE}/host/openwop-app/public/${encodeURIComponent(ORG)}/sitemap.xml`)).text();
    expect(r).not.toContain('getting-started');
  });
});
