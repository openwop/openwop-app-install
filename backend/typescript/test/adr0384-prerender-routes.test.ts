/**
 * ADR 0384 Phases 2–4 — crawler-prerender route gates:
 *  - the custom-domain prerender route serves full HTML (head + JSON-LD +
 *    semantic body) to ALL clients; kill-switch reverts it to 404;
 *  - published-only: a draft slug is a uniform 404; unknown org is 404;
 *  - platform-origin document paths UA-branch (bot → prerender, human → shell/
 *    404 without a configured shell) and ALWAYS carry `Vary: User-Agent`;
 *  - no-cloaking: the prerendered body's visible text ⊆ the projected section
 *    text (the same page the SPA renders);
 *  - custom-domain documents: `/` + `/p/:slug` on a bound host rewrite to the
 *    org's prerender (bots AND humans), cross-org API paths still 404.
 *
 * TST-BQR-6. Red when: the kill-switch is ignored; a draft page is served;
 * the platform door drops `Vary: User-Agent`, answers bots `public`-cacheable,
 * or serves the prerender to a human UA; the body carries text the projection
 * lacks (cloaking); og:site_name stops coming from the org record; the
 * bound-host `/p/:slug` rewrite is removed; a bound host reaches ANOTHER org's
 * public page. Honest ceiling: "no site org ⇒ no guessing" can only show a
 * 404 with no page content — a guess at an org id that has no published `home`
 * is indistinguishable from not guessing.
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
afterEach(() => {
  delete process.env.OPENWOP_SEO_PRERENDER_DISABLED;
  delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
  delete process.env.OPENWOP_SPA_SHELL_FILE;
});

interface Res<T> { status: number; body: T }
interface OrgBody { orgId: string }
interface PageBody { pageId: string; slug: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  };
  return { post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

/** Raw GET with arbitrary Host / User-Agent headers, returning raw text. */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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

const HEADING = 'Prerender Test Heading';
const SUBTEXT = 'A rich paragraph for crawlers.';

/** An org with one PUBLISHED page (slug returned) + one DRAFT page. */
async function siteOrg(): Promise<{ orgId: string; slug: string; draftSlug: string }> {
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `pre-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Prerender Co' });
  const orgId = org.body.orgId;
  const page = await owner.post<PageBody>(cms(orgId, '/pages'), {
    title: 'Prerender Page',
    sections: [
      { type: 'hero', data: { heading: HEADING, subheading: 'Sub with **bold**' } },
      { type: 'richText', data: { heading: 'Body', text: SUBTEXT } },
    ],
  });
  expect(page.status, JSON.stringify(page.body)).toBe(201);
  const pageId = page.body.pageId;
  const slug = page.body.slug;
  expect((await owner.post(cms(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
  const draft = await owner.post<PageBody>(cms(orgId, '/pages'), { title: 'Draft Page', sections: [{ type: 'hero', data: { heading: 'Draft heading' } }] });
  return { orgId, slug, draftSlug: draft.body.slug };
}

const prerenderPath = (orgId: string, slug: string): string =>
  `/host/openwop-app/public/${encodeURIComponent(orgId)}/prerender/${encodeURIComponent(slug)}`;

describe('ADR 0384 — prerender route (custom-domain door)', () => {
  it('serves a full HTML document: head from the projection, JSON-LD, semantic body', async () => {
    const { orgId, slug } = await siteOrg();
    const res = await rawGet(prerenderPath(orgId, slug), {});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toContain('public');
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('<title>Prerender Page</title>');
    expect(res.body).toContain('<link rel="canonical"');
    expect(res.body).toContain('og:title');
    expect(res.body).toContain('application/ld+json');
    expect(res.body).toContain(`<h1>${HEADING}</h1>`);
    // og:site_name honestly from the org record (never invented)
    expect(res.body).toContain('Prerender Co');
  });

  it('no-cloaking: every visible body text is present in the projected page JSON', async () => {
    const { orgId, slug } = await siteOrg();
    const [html, json] = await Promise.all([
      rawGet(prerenderPath(orgId, slug), {}),
      rawGet(`/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`, {}),
    ]);
    const body = /<body>([\s\S]*)<\/body>/.exec(html.body)?.[1] ?? '';
    const texts = body.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter((s) => s.length > 3);
    expect(texts.length).toBeGreaterThan(0);
    const projected = JSON.stringify(JSON.parse(json.body));
    for (const t of texts) {
      expect(projected, `prerendered text "${t}" must come from the projection`).toContain(t.replace(/&amp;/g, '&'));
    }
  });

  it('published-only + uniform 404: draft slug and unknown org both 404', async () => {
    const { orgId, draftSlug } = await siteOrg();
    expect((await rawGet(prerenderPath(orgId, draftSlug), {})).status).toBe(404);
    expect((await rawGet(prerenderPath('org-does-not-exist', 'home'), {})).status).toBe(404);
  });

  it('kill-switch reverts the route to 404', async () => {
    const { orgId, slug } = await siteOrg();
    process.env.OPENWOP_SEO_PRERENDER_DISABLED = 'true';
    expect((await rawGet(prerenderPath(orgId, slug), {})).status).toBe(404);
  });
});

describe('ADR 0384 — platform-origin document paths', () => {
  it('bot UA gets the prerendered page; Vary includes User-Agent', async () => {
    const { orgId, slug } = await siteOrg();
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = orgId;
    const res = await rawGet(`/p/${encodeURIComponent(slug)}`, { 'user-agent': 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(String(res.headers.vary)).toContain('User-Agent');
    // no-store on the PLATFORM door: the Hosting CDN strips Vary, so a
    // public-cached UA-branched response would cross audiences (cache poisoning).
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain(`<h1>${HEADING}</h1>`);
  });

  it('human UA without a configured shell: honest 404, still Vary: User-Agent', async () => {
    const { orgId, slug } = await siteOrg();
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = orgId;
    const res = await rawGet(`/p/${encodeURIComponent(slug)}`, { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1' });
    expect(res.status).toBe(404);
    expect(String(res.headers.vary)).toContain('User-Agent');
  });

  it('bot UA with no site org configured falls to the human path (no guessing)', async () => {
    await siteOrg(); // a published page exists somewhere; it must not be served
    const res = await rawGet('/', { 'user-agent': 'Slackbot-LinkExpanding 1.0' });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain(HEADING);
    expect(String(res.headers.vary)).toContain('User-Agent');
  });
});

describe('ADR 0384 — custom-domain document rewrite', () => {
  it('`/` and `/p/:slug` on a bound host serve the org prerender to bots AND humans; cross-org API still 404', async () => {
    const { orgId, slug } = await siteOrg();
    await __resetCustomDomains();
    const host = `docs-${n}.example.com`;
    const d = await addDomain({ tenantId: 't-any', orgId, createdBy: 'u', hostname: host });
    await verifyDomain('t-any', orgId, host, async () => [[d.verificationToken]]);
    invalidateHostCache();

    const asHuman = await rawGet(`/p/${encodeURIComponent(slug)}`, { host, 'user-agent': 'Mozilla/5.0 Safari' });
    expect(asHuman.status).toBe(200);
    expect(asHuman.body).toContain(`<h1>${HEADING}</h1>`);
    const asBot = await rawGet(`/p/${encodeURIComponent(slug)}`, { host, 'user-agent': 'GPTBot/1.0' });
    expect(asBot.status).toBe(200);
    expect(asBot.body).toContain(`<h1>${HEADING}</h1>`);

    // `/` maps to the published `home` slug — this org has none → uniform 404.
    expect((await rawGet('/', { host, 'user-agent': 'GPTBot/1.0' })).status).toBe(404);
    // The org-pinning invariant is untouched for API paths: a REAL second org's
    // published page is 404 through this org's bound host…
    const other = await siteOrg();
    const otherPage = `/host/openwop-app/public/${encodeURIComponent(other.orgId)}/pages/${encodeURIComponent(other.slug)}`;
    expect((await rawGet(otherPage, { host })).status).toBe(404);
    // …while the same path on the platform origin serves it (positive control).
    expect((await rawGet(otherPage, {})).status).toBe(200);
  });
});
