/**
 * ADR 1030 P2 — a workspace's custom-domain site in its OWN brand.
 *
 *   1. The backend theme generator is the SPA's, byte for byte (the three
 *      `features/brand/theme/*.ts` mirrors equal `frontend/react/src/brand/theme/*.ts`),
 *      so the contrast-critical tokens are AA-solved the same way (ADR 0510 §5).
 *   2. A brand identity becomes one token block on `[data-owp-site]`: the accent
 *      exactly, the AA-solved accent text, the motion preset; a dark block under
 *      the OS preference; '' when the identity sets nothing.
 *   3. The site-brand route lists only the workspace's own brands with an
 *      identity, refuses another org's brand or one without an identity (400), and
 *      clears with null.
 *   4. With designed pages on and a brand chosen, the prerender carries the token
 *      block after the stylesheet link; with no brand chosen it carries none.
 *   5. A DSAR erasure of the person who chose the brand redacts `updatedBy` and
 *      keeps the choice (ADR 0464; the workflow:budget precedent).
 *
 * Sabotage-witnessed (2026-11-02): editing one mirrored generator line reds 1;
 * dropping the org check in `setSiteBrandId` reds 3; not injecting the tokens
 * reds 4; emitting the raw accent as `--clay-text` reds 2; an eraser that
 * skips the put reds 5.
 * Re-measured w85, each witnessed: the identity check on set and on the listing,
 * the dark block, the motion input, '' for an empty identity, dropping the token
 * cache on set and on clear, and reporting a deleted brand's stale pointer; and
 * (after w85) an eraser that redacts every chooser, or reaches past its tenant.
 *
 * Double guard, recorded: every token value is the generator's own output (it
 * parses each seed and never echoes the string) AND `SAFE_TOKEN_VALUE` filters
 * each value, so weakening the filter alone reds nothing. The hostile cases pin
 * the combined outcome. The DSAR fan-out registration is held by
 * `subject-erasure-coverage.test.ts` (`site:brand`); this file drives the eraser.
 */
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { addDomain, verifyDomain, invalidateHostCache, __resetCustomDomains } from '../src/host/customDomains.js';
import { DESIGNED_PAGES_TOGGLE, __resetSiteRuntimeForTests } from '../src/features/publishing/siteRuntime.js';
import { createBrand, deleteBrand } from '../src/features/brand/brandService.js';
import type { BrandTheme } from '../src/features/brand/types.js';
import { siteBrandTokenCss, setSiteBrandId, getSiteBrandId, eraseSubjectSiteBrand, __resetSiteBrandForTests } from '../src/host/siteBrand.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

describe('the theme generator mirror', () => {
  it.each(['generate', 'oklch', 'contrast'])('backend %s.ts is the SPA file, byte for byte', (name) => {
    const be = readFileSync(join(REPO, 'backend/typescript/src/features/brand/theme', `${name}.ts`), 'utf8');
    const fe = readFileSync(join(REPO, 'frontend/react/src/brand/theme', `${name}.ts`), 'utf8');
    expect(be).toBe(fe);
  });
});

describe('a brand identity as site tokens', () => {
  it('sets the accent exactly, an AA-solved accent text, the motion preset, and a dark block', () => {
    const css = siteBrandTokenCss({ colors: { accent: 'oklch(70% 0.2 140)' }, theme: { motion: 'lively' } });
    const light = css.split('\n')[0]!;
    expect(light.startsWith('[data-owp-site]{')).toBe(true);
    expect(light).toMatch(/--clay:oklch\(70(\.0)?% 0\.2 140\)/);
    const text = /--clay-text:([^;}]+)/.exec(light)?.[1] ?? '';
    expect(text, 'accent text is solved, not the raw accent').not.toMatch(/^oklch\(70(\.0)?% 0\.2 140\)$/);
    expect(light).toContain('--reveal-distance:28px');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\{\[data-owp-site\]\{/);
    expect(css).not.toMatch(/[<>]/);
  });

  // A brand's colour strings never reach the page: every value is the generator's
  // own output. Fed HOSTILE values directly (as if stored data had bypassed the
  // write-time sanitizer), the block holds nothing that could close the <style>,
  // open a tag, or start a new rule.
  it('puts no raw brand string on the page, even for hostile stored values', () => {
    const hostile = ['</style><script>alert(1)</script>', 'red;}body{display:none', 'url(javascript:alert(1))', 'oklch(50% 0.1 40)</style>'];
    for (const v of hostile) {
      const theme: BrandTheme = { accentSeed: v, neutralSeed: v };
      const css = siteBrandTokenCss({ colors: { accent: v }, theme });
      expect(css, v).not.toMatch(/[<>]/);
      expect(css, v).not.toMatch(/script|javascript|url\(|display:none/i);
      // Only token declarations: every rule body is `--name:value` pairs.
      for (const body of css.match(/\{([^{}]*)\}/g) ?? []) {
        for (const decl of body.slice(1, -1).split(';')) expect(decl, v).toMatch(/^--[a-z0-9-]+:[^;{}<>]+$/);
      }
    }
  });

  it('is empty for an identity that sets nothing the generator reads', () => {
    expect(siteBrandTokenCss({ productName: 'Acme' })).toBe('');
  });
});

let BASE: string; let PORT = 0; let server: http.Server; let dir: string;
const ENTRY = 'main-Ab12_c.js';
const STYLE = 'site-Zz9_q.css';
const prevDir = process.env.OPENWOP_SITE_RUNTIME_DIR;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-site-brand-'));
  writeFileSync(join(dir, ENTRY), 'console.log(1);');
  writeFileSync(join(dir, STYLE), '[data-owp-site]{color:var(--ink)}');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entry: ENTRY, style: STYLE, files: [ENTRY, STYLE] }));
  process.env.OPENWOP_SITE_RUNTIME_DIR = dir;
  __resetSiteRuntimeForTests();
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

interface Body { user?: { tenantId?: string }; orgId: string; pageId: string; brandId?: string | null; choices?: Array<{ id: string; name: string }>; error?: string; message?: string }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text === '' ? '{}' : text) as Body };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
function raw(path: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { host, 'user-agent': 'Mozilla/5.0' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the site-brand route and the prerender', () => {
  it('chooses only an own brand with an identity, and the page carries its tokens', async () => {
    await __resetCustomDomains();
    __resetSiteBrandForTests();
    const user = client();
    const login = await user.post('/host/openwop-app/test/login', { email: `sb-${Date.now()}@acme.test` });
    const tenantId = login.body.user?.tenantId ?? '';
    const orgId = (await user.post('/host/openwop-app/orgs', { name: 'Brand Co' })).body.orgId;
    const otherOrg = (await user.post('/host/openwop-app/orgs', { name: 'Other Co' })).body.orgId;
    const pages = `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`;
    const page = await user.post(pages, { title: 'Home', slug: 'home' });
    expect((await user.post(`${pages}/${page.body.pageId}/publish`)).status).toBe(200);
    const host = 'brand.acme.test';
    const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: host });
    await verifyDomain(tenantId, orgId, host, async () => [[added.verificationToken]]);
    invalidateHostCache();
    const d = getToggleDefault(DESIGNED_PAGES_TOGGLE)!;
    await saveConfig({ ...d, tenantOverrides: { [tenantId]: { status: 'on' } } }, 'test');

    const mine = await createBrand(tenantId, orgId, 'u', { name: 'Green', identity: { colors: { accent: 'oklch(70% 0.2 140)' } } });
    const plain = await createBrand(tenantId, orgId, 'u', { name: 'Voice only' });
    const foreign = await createBrand(tenantId, otherOrg, 'u', { name: 'Theirs', identity: { colors: { accent: '#ff0000' } } });
    expect(foreign.identity, 'precondition: the foreign brand HAS an identity, so only the org check can refuse it').toBeDefined();
    expect(plain.identity, 'precondition: the plain brand has none').toBeUndefined();
    /** It IS the designed page (the sheet is linked), just with no brand tokens. */
    const unbranded = (html: string): void => {
      expect(html).toContain(`/_rt/${STYLE}`);
      expect(html).not.toContain('<style>');
    };
    const REFUSAL = 'Choose one of this workspace\'s brands that has an app identity.';
    const route = `/host/openwop-app/custom-domains/orgs/${encodeURIComponent(orgId)}/site-brand`;

    const listed = await user.get(route);
    expect(listed.status).toBe(200);
    expect(listed.body.brandId).toBeNull();
    expect(listed.body.choices).toEqual([{ id: mine.id, name: 'Green' }]);

    unbranded(await raw('/', host));

    for (const refused of [foreign.id, plain.id]) {
      const r = await user.put(route, { brandId: refused });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'validation_error', message: REFUSAL });
    }
    expect((await user.get(route)).body.brandId, 'a refused choice stored nothing').toBeNull();
    const set = await user.put(route, { brandId: mine.id });
    expect(set.status).toBe(200);
    expect((await user.get(route)).body.brandId).toBe(mine.id);

    const html = await raw('/', host);
    const link = html.indexOf(`/_rt/${STYLE}`);
    const style = html.indexOf('<style>[data-owp-site]{');
    expect(link).toBeGreaterThan(0);
    expect(style).toBeGreaterThan(link);
    expect(style).toBeLessThan(html.indexOf('</head>'));
    expect(html).toMatch(/--clay:oklch\(70(\.0)?% 0\.2 140\)/);

    expect((await user.put(route, { brandId: null })).body.brandId).toBeNull();
    unbranded(await raw('/', host));

    // A brand saved with hostile colour strings beside one valid colour: the write
    // sanitizer keeps the identity (so the choice is allowed), and the page carries
    // no tag and no raw string from the hostile values.
    const evil = await createBrand(tenantId, orgId, 'u', { name: 'Evil', identity: { colors: { accent: 'oklch(50% 0.1 40)', ink: '</style><script>alert(1)</script>' }, theme: { accentSeed: 'red;}body{display:none}', neutralSeed: '#fff</style>' } } });
    expect(evil.identity, 'precondition: the identity survived, so the hostile leg runs').toBeDefined();
    expect((await user.put(route, { brandId: evil.id })).status).toBe(200);
    const evilPage = await raw('/', host);
    expect(evilPage).toMatch(/--clay:oklch\(50(\.0)?% 0\.1 40\)/);
    expect(evilPage).not.toContain('<script>alert');
    expect(evilPage).not.toContain('display:none');
    expect(evilPage.match(/<style>/g) ?? []).toHaveLength(1);
    expect((await user.put(route, { brandId: null })).status).toBe(200);

    // A chosen brand that is later deleted reads as none, and the page falls back.
    expect((await user.put(route, { brandId: mine.id })).status).toBe(200);
    expect(await deleteBrand(tenantId, mine.id)).toBe(true);
    __resetSiteBrandForTests();
    expect((await user.get(route)).body.brandId).toBeNull();
    unbranded(await raw('/', host));
  });
});

describe('subject erasure', () => {
  it('redacts the chooser and keeps the workspace\'s brand choice', async () => {
    const tenantId = `t-erase-${Date.now()}`;
    const otherTenant = `${tenantId}-other`;
    const brand = await createBrand(tenantId, 'org-e', 'u', { name: 'Kept', identity: { colors: { accent: '#336699' } } });
    const sibling = await createBrand(tenantId, 'org-f', 'u', { name: 'Sibling', identity: { colors: { accent: '#996633' } } });
    const elsewhere = await createBrand(otherTenant, 'org-e', 'u', { name: 'Elsewhere', identity: { colors: { accent: '#669933' } } });
    await setSiteBrandId(tenantId, 'org-e', brand.id, 'user:erase-me');
    // Same tenant, another chooser: must keep its attribution.
    await setSiteBrandId(tenantId, 'org-f', sibling.id, 'user:someone-else');
    // Another tenant, the SAME subject key: outside this erasure's tenant.
    await setSiteBrandId(otherTenant, 'org-e', elsewhere.id, 'user:erase-me');
    const rows = new DurableCollection<{ tenantId: string; orgId: string; brandId: string; updatedBy: string }>('site:brand', (s) => `${s.tenantId}:${s.orgId}`);
    expect((await rows.get(`${tenantId}:org-e`))?.updatedBy, 'precondition').toBe('user:erase-me');
    await eraseSubjectSiteBrand(tenantId, 'user:erase-me');
    expect((await rows.get(`${tenantId}:org-e`))?.updatedBy).toBe('[erased]');
    expect(await getSiteBrandId(tenantId, 'org-e')).toBe(brand.id);
    expect((await rows.get(`${tenantId}:org-f`))?.updatedBy, 'another chooser is not erased').toBe('user:someone-else');
    expect((await rows.get(`${otherTenant}:org-e`))?.updatedBy, 'another tenant is not erased').toBe('user:erase-me');
  });
});
