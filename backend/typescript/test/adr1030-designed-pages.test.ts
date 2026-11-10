/**
 * ADR 1030 — designed pages on a bound custom domain, through the real HTTP
 * boundary (host guard → prerender → `_rt` asset route).
 *
 *   - D4: the page links the designed-pages stylesheet, in `<head>`, and marks
 *     `<body data-owp-site>` ONLY when the workspace's
 *     `custom-domains.designed-pages` toggle is on; off, the page is unchanged.
 *     It is independent of the visitor runtime (no script needed), and a page that
 *     names the stylesheet is `no-cache` (the file belongs to this image).
 *   - D2: the stylesheet is served only when the manifest names it as a listed
 *     file, as `text/css` + nosniff; a manifest without a style links nothing.
 *   - D1: each section's root carries its `data-owp-*` hooks (type, layout,
 *     visual, motion) whether or not the toggle is on.
 *
 * Sabotage-witnessed (2026-11-02; re-measured /grade-tests wave 84, TST-FPA-1):
 * ignoring the toggle reds the off case; gating the sheet on the runtime toggle,
 * putting the link after `<body>`, dropping the site mark, dropping `style` from
 * the no-cache condition, serving an unlisted file, serving css as js or
 * dropping nosniff each red the on case; trusting a manifest style it does not
 * list reds D2; dropping the motion hook or the hook stamping reds D1; marking
 * every prerender `no-cache` reds the off case. The D2 case ends on a positive
 * control (the same host links the sheet once the manifest lists it).
 */
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { addDomain, verifyDomain, invalidateHostCache, __resetCustomDomains } from '../src/host/customDomains.js';
import { DESIGNED_PAGES_TOGGLE, SITE_RUNTIME_TOGGLE, __resetSiteRuntimeForTests } from '../src/features/publishing/siteRuntime.js';

let BASE: string; let PORT = 0; let server: http.Server; let dir: string;
const ENTRY = 'main-Ab12_c.js';
const STYLE = 'site-Zz9_q.css';
const CSS = '[data-owp-site] h1 { color: var(--ink); }';
const prevDir = process.env.OPENWOP_SITE_RUNTIME_DIR;

function writeManifest(style: 'listed' | 'none' | 'unlisted'): void {
  const m = style === 'listed' ? { entry: ENTRY, style: STYLE, files: [ENTRY, STYLE] }
    : style === 'unlisted' ? { entry: ENTRY, style: 'site-unlisted.css', files: [ENTRY] }
      : { entry: ENTRY, files: [ENTRY] };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  __resetSiteRuntimeForTests();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-designed-pages-'));
  writeFileSync(join(dir, ENTRY), 'console.log(1);');
  writeFileSync(join(dir, STYLE), CSS);
  writeFileSync(join(dir, 'site-unlisted.css'), 'body{display:none}');
  process.env.OPENWOP_SITE_RUNTIME_DIR = dir;
  writeManifest('listed');
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
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (prevDir === undefined) delete process.env.OPENWOP_SITE_RUNTIME_DIR; else process.env.OPENWOP_SITE_RUNTIME_DIR = prevDir;
  __resetSiteRuntimeForTests();
  rmSync(dir, { recursive: true, force: true });
});

interface Body { user?: { tenantId?: string }; orgId: string; pageId: string; slug: string }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text === '' ? '{}' : text) as Body };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: string }
function raw(path: string, host: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { host, 'user-agent': 'Mozilla/5.0' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SECTIONS = [
  { type: 'hero', data: { heading: 'Welcome', visual: 'activity', motion: 'rise', activity: { items: [{ actor: 'Ana', action: 'approved' }] } } },
  { type: 'columns', data: { heading: 'Steps', layout: 'timeline', motion: 'stagger', columns: [{ title: 'One', text: 'First.' }] } },
];

let seq = 0;
async function boundSite(host: string): Promise<{ orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post('/host/openwop-app/test/login', { email: `dp-${Date.now()}-${seq++}@acme.test` });
  expect(login.status).toBe(201);
  const tenantId = login.body.user?.tenantId ?? '';
  const org = await user.post('/host/openwop-app/orgs', { name: 'Designed Co' });
  const orgId = org.body.orgId;
  const base = `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`;
  const page = await user.post(base, { title: 'Home', slug: 'home' });
  expect(page.status).toBe(201);
  expect((await user.patch(`${base}/${page.body.pageId}`, { sections: SECTIONS })).status).toBe(200);
  expect((await user.post(`${base}/${page.body.pageId}/publish`)).status).toBe(200);
  const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: host });
  await verifyDomain(tenantId, orgId, host, async () => [[added.verificationToken]]);
  invalidateHostCache();
  return { orgId, tenantId };
}

async function setToggle(id: string, tenantId: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  expect(d, `${id} is registered`).toBeTruthy();
  await saveConfig({ ...d!, tenantOverrides: { [tenantId]: { status } } }, 'test');
}

const linkTags = (html: string): string[] => html.match(/<link rel="stylesheet"[^>]*>/g) ?? [];

describe('ADR 1030 — designed pages on a bound custom domain', () => {
  it('off by default: no stylesheet, no site mark, but the section hooks are there (D1, D4)', async () => {
    await __resetCustomDomains();
    await boundSite('plain.acme.test');
    const page = await raw('/', 'plain.acme.test');
    expect(page.status).toBe(200);
    expect(linkTags(page.body)).toEqual([]);
    expect(page.body).toContain('<body>');
    // Off, the page keeps the prerender's public cache: `no-cache` belongs only to
    // a page that names the image's stylesheet (or script).
    expect(page.headers['cache-control']).toMatch(/^public, max-age=\d+$/);
    expect(page.body).toContain('<header data-owp-section="hero" data-owp-visual="activity" data-owp-motion="rise">');
    expect(page.body).toContain('<section data-owp-section="columns" data-owp-layout="timeline" data-owp-motion="stagger">');
  });

  it('on: one stylesheet link in <head>, <body data-owp-site>, no-cache, and no script without the runtime toggle', async () => {
    await __resetCustomDomains();
    const { orgId, tenantId } = await boundSite('designed.acme.test');
    await setToggle(DESIGNED_PAGES_TOGGLE, tenantId, 'on');
    await setToggle(SITE_RUNTIME_TOGGLE, tenantId, 'off');
    const page = await raw('/', 'designed.acme.test');
    const href = `/host/openwop-app/public/${encodeURIComponent(orgId)}/_rt/${STYLE}`;
    expect(linkTags(page.body)).toEqual([`<link rel="stylesheet" href="${href}">`]);
    expect(page.body.indexOf(href)).toBeLessThan(page.body.indexOf('</head>'));
    expect(page.body).toContain('<body data-owp-site>');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.body).not.toMatch(/<script type="module"/);

    const css = await raw(href, 'designed.acme.test');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.headers['x-content-type-options']).toBe('nosniff');
    expect(css.body).toBe(CSS);
    expect((await raw(`/host/openwop-app/public/${encodeURIComponent(orgId)}/_rt/site-unlisted.css`, 'designed.acme.test')).status).toBe(404);
  });

  it('a manifest with no stylesheet, or one naming a file it does not list, links nothing (D2)', async () => {
    await __resetCustomDomains();
    const { tenantId } = await boundSite('nostyle.acme.test');
    await setToggle(DESIGNED_PAGES_TOGGLE, tenantId, 'on');
    try {
      for (const style of ['none', 'unlisted'] as const) {
        writeManifest(style);
        const page = await raw('/', 'nostyle.acme.test');
        expect(linkTags(page.body), style).toEqual([]);
        expect(page.body, style).toContain('<body>');
      }
      // Positive control: the same bound host, toggle and page DO link the sheet
      // once the manifest lists it, so the absences above are the manifest's doing.
      writeManifest('listed');
      const control = await raw('/', 'nostyle.acme.test');
      expect(linkTags(control.body)).toHaveLength(1);
      expect(control.body).toContain('<body data-owp-site>');
    } finally {
      writeManifest('listed');
    }
  });
});
