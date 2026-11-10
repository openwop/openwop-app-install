/**
 * ADR 1015 — the tenant site visitor runtime on a bound custom domain, through
 * the real HTTP boundary (host guard → prerender → asset route).
 *
 *   - Every prerender response carries the D7 CSP.
 *   - The page loads the runtime script only when the workspace's
 *     `custom-domains.visitor-runtime` toggle is on (D4); off, no script.
 *   - The script is served from the image by manifest only (D6): a listed file is
 *     `text/javascript` + nosniff, anything else 404s, and another org's path is
 *     the guard's 404.
 *   - The consent lane and the analytics lane are reachable on the bound host for
 *     the bound org only (D5); owner analytics reads stay unreachable.
 *
 * Red on the old code: no CSP, no script, `/_rt/` unrouted, and both lanes were
 * the guard's 404 on every customer host.
 *
 * Sabotage-checked (w83 probes): the CSP header dropped or weakened (the policy is
 * pinned here as a literal, never read from the module that sets it); the toggle
 * or the host kill switch ignored; a file outside the manifest served; the wrong
 * content type or no nosniff on the asset; a tagged page left on the public cache;
 * the tag after `</body>`; a privacy attribute with no privacy page; the manifest
 * latch caching a transient failure, or re-reading a missing manifest; beacons
 * charged to the page bucket; the lanes dropped from the guard's prefixes; the
 * bot prerender without the CSP, or the browser shell with it.
 *
 * Double guards, recorded: another org's path is refused twice in
 * `middleware/customDomain.ts` (the miss branch, then the org pin), so a probe on
 * either alone stays green; the w83 held pair breaks both. The `..%2F` traversal
 * is refused by `SAFE_FILE` and by the manifest set in one function, and cannot
 * serve anything in this fixture either way.
 */
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { addDomain, verifyDomain, invalidateHostCache, __resetCustomDomains } from '../src/host/customDomains.js';
import { SITE_RUNTIME_TOGGLE, __resetSiteRuntimeForTests, loadRuntimeManifest } from '../src/features/publishing/siteRuntime.js';
import { __resetShellCacheForTests } from '../src/features/publishing/routes.js';

let BASE: string; let PORT = 0; let server: http.Server; let dir: string;
const ENTRY = 'main-Ab12_c.js';
const SCRIPT = 'console.log("site runtime");';
const prevDir = process.env.OPENWOP_SITE_RUNTIME_DIR;
/** ADR 1015 D7, written out: a weakened policy in the source must turn this red. */
const PRERENDER_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' https: data:; "
  + "media-src 'self' https:; frame-src https:; style-src 'self' 'unsafe-inline'; font-src 'self' https: data:; "
  + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-site-runtime-'));
  writeFileSync(join(dir, ENTRY), SCRIPT);
  writeFileSync(join(dir, 'not-listed.js'), 'alert(1)');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entry: ENTRY, files: [ENTRY] }));
  process.env.OPENWOP_SITE_RUNTIME_DIR = dir;
  __resetSiteRuntimeForTests();
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  for (const id of ['users', 'custom-domains', 'consent', 'analytics']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
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
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text === '' ? '{}' : text) as Body };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: string }
/** Raw request with a spoofed Host header (fetch forbids overriding Host). */
function raw(method: string, path: string, host: string, extra: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { host, ...extra } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

let seq = 0;
async function boundSite(host: string, extraPages: string[] = []): Promise<{ orgId: string; tenantId: string; slug: string }> {
  const user = client();
  const login = await user.post('/host/openwop-app/test/login', { email: `rt-${Date.now()}-${seq++}@acme.test` });
  expect(login.status).toBe(201);
  const tenantId = login.body.user?.tenantId ?? '';
  const org = await user.post('/host/openwop-app/orgs', { name: 'Runtime Co' });
  expect(org.status).toBe(201);
  const orgId = org.body.orgId;
  const page = await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title: 'Runtime Home' });
  expect(page.status).toBe(201);
  expect((await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${page.body.pageId}/publish`)).status).toBe(200);
  for (const title of extraPages) {
    const p = await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
    expect(p.status).toBe(201);
    expect((await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${p.body.pageId}/publish`)).status).toBe(200);
  }
  const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: host });
  await verifyDomain(tenantId, orgId, host, async () => [[added.verificationToken]]);
  invalidateHostCache();
  return { orgId, tenantId, slug: page.body.slug };
}

async function setRuntime(tenantId: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(SITE_RUNTIME_TOGGLE);
  expect(d, 'the toggle is registered').toBeTruthy();
  await saveConfig({ ...d!, tenantOverrides: { [tenantId]: { status } } }, 'test');
}

const scriptTags = (html: string): string[] => html.match(/<script type="module"[^>]*><\/script>/g) ?? [];

describe('ADR 1015 — visitor runtime on a bound custom domain', () => {
  it('off by default: the page carries the CSP and no runtime script', async () => {
    await __resetCustomDomains();
    const { slug } = await boundSite('off.acme.test');
    const page = await raw('GET', `/p/${encodeURIComponent(slug)}`, 'off.acme.test');
    expect(page.status).toBe(200);
    expect(page.body).toContain('Runtime Home');
    expect(page.headers['content-security-policy']).toBe(PRERENDER_CSP);
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(scriptTags(page.body)).toEqual([]);
  });

  it('on for the workspace: the page loads the manifest entry, which serves as JavaScript', async () => {
    await __resetCustomDomains();
    const { orgId, tenantId, slug } = await boundSite('on.acme.test');
    await setRuntime(tenantId, 'on');
    const page = await raw('GET', `/p/${encodeURIComponent(slug)}`, 'on.acme.test');
    expect(page.status).toBe(200);
    const src = `/host/openwop-app/public/${encodeURIComponent(orgId)}/_rt/${ENTRY}`;
    expect(scriptTags(page.body)).toEqual([`<script type="module" src="${src}" data-owp-org="${orgId}"></script>`]);
    expect(page.body.indexOf('<script type="module"')).toBeLessThan(page.body.lastIndexOf('</body>'));

    const asset = await raw('GET', src, 'on.acme.test');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect(asset.body).toBe(SCRIPT);

    // Only manifest-named files; never a traversal; never another org's path.
    expect((await raw('GET', `/host/openwop-app/public/${encodeURIComponent(orgId)}/_rt/not-listed.js`, 'on.acme.test')).status).toBe(404);
    expect((await raw('GET', `/host/openwop-app/public/${encodeURIComponent(orgId)}/_rt/..%2Fmanifest.json`, 'on.acme.test')).status).toBe(404);
    expect((await raw('GET', `/host/openwop-app/public/someone-else/_rt/${ENTRY}`, 'on.acme.test')).status).toBe(404);

    // A tagged page is revalidated on every load (its script is the current
    // image's only), not cached for the prerender's hour.
    expect(page.headers['cache-control']).toBe('no-cache');

    // Turning it back off removes the script.
    await setRuntime(tenantId, 'off');
    expect(scriptTags((await raw('GET', `/p/${encodeURIComponent(slug)}`, 'on.acme.test')).body)).toEqual([]);
  });

  it('the host kill switch drops the script for every workspace', async () => {
    await __resetCustomDomains();
    const { tenantId, slug } = await boundSite('kill.acme.test');
    await setRuntime(tenantId, 'on');
    process.env.OPENWOP_SITE_RUNTIME = 'off';
    try {
      const page = await raw('GET', `/p/${encodeURIComponent(slug)}`, 'kill.acme.test');
      expect(page.status).toBe(200);
      expect(scriptTags(page.body)).toEqual([]);
      expect(page.headers['cache-control']).toMatch(/^public, max-age=/);
    } finally { delete process.env.OPENWOP_SITE_RUNTIME; }
    expect(scriptTags((await raw('GET', `/p/${encodeURIComponent(slug)}`, 'kill.acme.test')).body)).toHaveLength(1);
  });

  it('beacon traffic has its own per-domain bucket, so it cannot starve page loads', async () => {
    await __resetCustomDomains();
    const { orgId, slug } = await boundSite('bucket.acme.test');
    const prev = { page: process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN, beacon: process.env.OPENWOP_CUSTOM_DOMAIN_BEACON_REQS_PER_MIN };
    process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN = '3';
    process.env.OPENWOP_CUSTOM_DOMAIN_BEACON_REQS_PER_MIN = '2';
    try {
      const beacon = (): Promise<Raw> => raw('GET', `/host/openwop-app/public-analytics/${encodeURIComponent(orgId)}/capture-config`, 'bucket.acme.test');
      expect((await beacon()).status).toBe(200);
      expect((await beacon()).status).toBe(200);
      expect((await beacon()).status, 'the beacon bucket is spent').toBe(429);
      // Page loads are untouched by the spent beacon bucket…
      for (let i = 0; i < 3; i++) expect((await raw('GET', `/p/${encodeURIComponent(slug)}`, 'bucket.acme.test')).status).toBe(200);
      // …and have their own limit.
      expect((await raw('GET', `/p/${encodeURIComponent(slug)}`, 'bucket.acme.test')).status).toBe(429);
    } finally {
      if (prev.page === undefined) delete process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN; else process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN = prev.page;
      if (prev.beacon === undefined) delete process.env.OPENWOP_CUSTOM_DOMAIN_BEACON_REQS_PER_MIN; else process.env.OPENWOP_CUSTOM_DOMAIN_BEACON_REQS_PER_MIN = prev.beacon;
    }
  });

  it('names the workspace privacy page only when one is published', async () => {
    await __resetCustomDomains();
    const { tenantId, slug } = await boundSite('priv.acme.test', ['Privacy']);
    await setRuntime(tenantId, 'on');
    const tags = scriptTags((await raw('GET', `/p/${encodeURIComponent(slug)}`, 'priv.acme.test')).body);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('data-owp-privacy="/p/privacy"');
    // A site with no privacy page: no attribute, no dead link.
    const plain = await boundSite('nopriv.acme.test');
    await setRuntime(plain.tenantId, 'on');
    const other = scriptTags((await raw('GET', `/p/${encodeURIComponent(plain.slug)}`, 'nopriv.acme.test')).body);
    expect(other).toHaveLength(1);
    expect(other[0]).not.toContain('data-owp-privacy');
  });

  // The CSP is for prerendered DOCUMENTS only. On the platform origin, `/` and
  // `/p/:slug` serve the SPA shell to browsers, and that shell needs things the
  // prerender CSP forbids (SSE on a direct *.run.app URL, fonts, its inline
  // script), so a browser must never receive it there.
  it('on the platform origin, the browser SPA shell never carries the prerender CSP; the bot prerender does', async () => {
    await __resetCustomDomains();
    const { orgId, slug } = await boundSite('shell.acme.test');
    const shellFile = join(dir, 'app-shell.html');
    writeFileSync(shellFile, '<!doctype html><html><head><script>/* inline theme */</script></head><body><div id="root"></div></body></html>');
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = orgId;
    process.env.OPENWOP_SPA_SHELL_FILE = shellFile;
    __resetShellCacheForTests();
    try {
      const platform = `127.0.0.1:${PORT}`;
      for (const path of ['/', `/p/${encodeURIComponent(slug)}`]) {
        const human = await raw('GET', path, platform, { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1 Safari/605.1' });
        expect(human.status, path).toBe(200);
        expect(human.body, path).toContain('<div id="root">');
        expect(human.headers['content-security-policy'], `${path}: the browser shell`).toBeUndefined();
      }
      const bot = await raw('GET', `/p/${encodeURIComponent(slug)}`, platform, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
      expect(bot.status).toBe(200);
      expect(bot.body).not.toContain('<div id="root">');
      expect(bot.headers['content-security-policy']).toBe(PRERENDER_CSP);
    } finally {
      delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
      delete process.env.OPENWOP_SPA_SHELL_FILE;
      __resetShellCacheForTests();
    }
  });

  it('the platform origin never injects the runtime, even with the toggle on', async () => {
    await __resetCustomDomains();
    const { orgId, tenantId, slug } = await boundSite('plat.acme.test');
    await setRuntime(tenantId, 'on');
    const page = await raw('GET', `/host/openwop-app/public/${encodeURIComponent(orgId)}/prerender/${encodeURIComponent(slug)}`, `127.0.0.1:${PORT}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(PRERENDER_CSP);
    expect(scriptTags(page.body)).toEqual([]);
  });

  it('the consent and analytics lanes reach their handlers for the bound org only', async () => {
    await __resetCustomDomains();
    const { orgId } = await boundSite('lanes.acme.test');
    const guard404 = (r: Raw): boolean => r.status === 404 && r.body.includes('"Not found."');
    const posture = await raw('GET', `/host/openwop-app/public-consent/${encodeURIComponent(orgId)}/posture`, 'lanes.acme.test');
    expect(posture.status, posture.body).toBe(200);
    expect(JSON.parse(posture.body)).toMatchObject({ regime: expect.any(String) });
    const capture = await raw('GET', `/host/openwop-app/public-analytics/${encodeURIComponent(orgId)}/capture-config`, 'lanes.acme.test');
    expect(guard404(capture), `analytics capture-config reached the guard: ${capture.status} ${capture.body}`).toBe(false);
    expect(capture.status, capture.body).toBe(200);
    expect(typeof (JSON.parse(capture.body) as { heatmaps?: unknown }).heatmaps).toBe('boolean');

    expect(guard404(await raw('GET', '/host/openwop-app/public-consent/other-org/posture', 'lanes.acme.test'))).toBe(true);
    expect(guard404(await raw('GET', '/host/openwop-app/public-analytics/other-org/capture-config', 'lanes.acme.test'))).toBe(true);
    // Owner reads are not on the customer host.
    expect(guard404(await raw('GET', `/host/openwop-app/analytics/orgs/${encodeURIComponent(orgId)}/summary`, 'lanes.acme.test'))).toBe(true);
  });
});

// The #3056 class (test/detached-latch-tripwire.test.ts): the manifest latch is
// module-scope, so one failed read must not leave the runtime off for the life of
// the process. "No manifest" is a fact about the image and stays cached; any other
// read failure is retried on the next request.
describe('ADR 1015 — the manifest latch recovers from a failed read', () => {
  it('a transient read failure is not cached; a later read loads the manifest', async () => {
    const other = mkdtempSync(join(tmpdir(), 'owp-site-runtime-latch-'));
    const saved = process.env.OPENWOP_SITE_RUNTIME_DIR;
    try {
      process.env.OPENWOP_SITE_RUNTIME_DIR = other;
      __resetSiteRuntimeForTests();
      mkdirSync(join(other, 'manifest.json')); // a directory: EISDIR, not ENOENT
      expect(await loadRuntimeManifest()).toBeNull();
      rmSync(join(other, 'manifest.json'), { recursive: true });
      writeFileSync(join(other, ENTRY), SCRIPT);
      writeFileSync(join(other, 'manifest.json'), JSON.stringify({ entry: ENTRY, files: [ENTRY] }));
      expect((await loadRuntimeManifest())?.entry, 'the failed read was cached').toBe(ENTRY);
    } finally {
      process.env.OPENWOP_SITE_RUNTIME_DIR = saved;
      __resetSiteRuntimeForTests();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('a missing manifest is cached as "no runtime" (the image has none)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'owp-site-runtime-none-'));
    const saved = process.env.OPENWOP_SITE_RUNTIME_DIR;
    try {
      process.env.OPENWOP_SITE_RUNTIME_DIR = empty;
      __resetSiteRuntimeForTests();
      expect(await loadRuntimeManifest()).toBeNull();
      writeFileSync(join(empty, ENTRY), SCRIPT);
      writeFileSync(join(empty, 'manifest.json'), JSON.stringify({ entry: ENTRY, files: [ENTRY] }));
      expect(await loadRuntimeManifest()).toBeNull();
    } finally {
      process.env.OPENWOP_SITE_RUNTIME_DIR = saved;
      __resetSiteRuntimeForTests();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
