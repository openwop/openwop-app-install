/**
 * ADR 0824 — the public site meets the answer-engine bar:
 *  D1 canonical / sitemap / feed URLs are the public PAGE urls (`/`, `/p/<slug>`),
 *     never the JSON read;
 *  D2 the seeded system pages carry real titles + descriptions (PageSeo), and a
 *     person's edit is never clobbered;
 *  D3 home JSON-LD is WebSite + SoftwareApplication + VideoObject + Organization
 *     (sameAs), never Article; the film it describes is the film the SPA embeds;
 *  D4 root `/robots.txt` + `/sitemap.xml` are real, public, and name public URLs;
 *  D5 root `/llms.txt` is public and opens with what the site IS;
 *  plus: CMS heading `*emphasis*` never reaches crawler HTML as asterisks.
 */
import http from 'node:http';
import { protocolVersions } from '../src/middleware/protocolVersion.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ensureSystemSite, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from '../src/host/systemSite.js';
import { ensureFeaturesPage } from '../src/host/featuresPage.js';
import { ensureSystemSiteDocs } from '../src/host/systemSiteDocs.js';
import { ensureSystemSiteSeo, SYSTEM_SITE_PAGE_SEO, __resetSystemSiteSeoForTests } from '../src/host/systemSiteSeo.js';
import { HERO_FILM, systemSiteProfile } from '../src/host/systemSiteProfile.js';
import { getSeo, putSeo, rootRobotsTxt, __resetPublicReadCaches } from '../src/features/publishing/publishingService.js';
import { isPublicPath } from '../src/middleware/auth.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { parseHeadingEmphasis, stripHeadingEmphasis, headingEmphasisHtml } from '../src/features/publishing/headingEmphasis.js';

let BASE = ''; let PORT = 0; let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  const docs = getToggleDefault('docs');
  if (docs) await saveConfig({ ...docs, status: 'on' }, 'test');
  await ensureSystemSite();
  await ensureFeaturesPage();
  await ensureSystemSiteDocs();
  __resetSystemSiteSeoForTests();
  await ensureSystemSiteSeo();
  __resetPublicReadCaches();
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => {
  delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
  delete process.env.OPENWOP_DEMO_MODE;
});

function get(path: string, ua = 'Mozilla/5.0'): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { 'user-agent': ua } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, type: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const jsonLd = (html: string): any[] =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
const canonical = (html: string): string | undefined => /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];

describe('ADR 0824 D1/D3 — crawler document for the system site', () => {
  it('home: canonical is the public `/`, real title, WebSite + SoftwareApplication + VideoObject, no Article', async () => {
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = SYSTEM_SITE_ORG;
    process.env.OPENWOP_DEMO_MODE = 'true';
    const res = await get('/', 'GPTBot/1.1');
    expect(res.status).toBe(200);
    expect(canonical(res.body)).toBe(`${BASE}/`);
    expect(res.body).not.toContain('/public/host-site/pages/');
    const want = SYSTEM_SITE_PAGE_SEO['page:host-site-home']!;
    expect(res.body).toContain(`<title>${want.metaTitle}</title>`);
    expect(res.body).toContain('<meta property="og:site_name" content="OpenWOP">');
    const blocks = jsonLd(res.body);
    const types = blocks.map((b) => b['@type']);
    expect(types).toEqual(expect.arrayContaining(['Organization', 'WebSite', 'WebPage', 'SoftwareApplication', 'VideoObject']));
    expect(types).not.toContain('Article');
    const org = blocks.find((b) => b['@type'] === 'Organization');
    expect(org.sameAs).toEqual(['https://openwop.dev', 'https://github.com/openwop']);
    const appBlock = blocks.find((b) => b['@type'] === 'SoftwareApplication');
    expect(appBlock).toMatchObject({ applicationCategory: 'DeveloperApplication', url: `${BASE}/`, isBasedOn: 'https://openwop.dev', offers: { price: '0' } });
    const video = blocks.find((b) => b['@type'] === 'VideoObject');
    expect(video).toMatchObject({ contentUrl: HERO_FILM.contentUrl, duration: 'PT1M34S', uploadDate: '2026-10-04' });
  });

  it('a non-home system page canonicalises to `/p/<slug>`', async () => {
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = SYSTEM_SITE_ORG;
    const res = await get('/p/features', 'ClaudeBot/1.0');
    expect(res.status).toBe(200);
    expect(canonical(res.body)).toBe(`${BASE}/p/features`);
    expect(res.body).toContain(`<title>${SYSTEM_SITE_PAGE_SEO['page:host-site-features']!.metaTitle}</title>`);
  });

  it('off the demo deployment the OpenWOP self-description is absent (white-label honesty)', () => {
    delete process.env.OPENWOP_DEMO_MODE;
    expect(systemSiteProfile(SYSTEM_SITE_ORG, 'home', BASE, 'x')).toBeNull();
    process.env.OPENWOP_DEMO_MODE = 'true';
    expect(systemSiteProfile('some-other-org', 'home', BASE, 'x')).toBeNull();
  });

  it('the VideoObject describes the film the SPA embeds (same ?v=)', () => {
    const src = readFileSync(join(__dirname, '../../../frontend/react/src/features/cms/SectionRenderer.tsx'), 'utf8');
    expect(src).toContain(`src: '${HERO_FILM.contentUrl}'`);
    expect(src).toContain(`poster: '${HERO_FILM.thumbnailUrl}'`);
  });
});

describe('ADR 0824 — default site copy claims nothing gated', () => {
  // The hero vignette caption read "Open standard" on every page that used the
  // default artwork. Two independent standards-readiness reviews declined that
  // status, and the corpus gates it behind cross-org governance plus Tier-3
  // adoption. These strings ship on every install, so they are held here.
  it('the site i18n bundles and the seeded launch post never claim standard status', () => {
    const gated = /industry standard|independently validated|best-in-class|fully conformant|vendor-neutral standard|open standard|estándar abierto|padrão aberto|standard ouvert/i;
    const files = [
      ...['en', 'es', 'fr', 'pt-BR'].map((l) => `../../../frontend/react/src/features/site/i18n/${l}.ts`),
      '../src/host/systemSiteBlog.ts',
    ];
    for (const f of files) expect(readFileSync(join(__dirname, f), 'utf8'), f).not.toMatch(gated);
  });
});

describe('ADR 0824 D2 — seeded page SEO', () => {
  it('every entry is within length and says nothing gated (the app is not open source)', () => {
    const gated = /industry standard|independently validated|best-in-class|fully conformant|vendor-neutral standard|open standard/i;
    for (const [id, s] of Object.entries(SYSTEM_SITE_PAGE_SEO)) {
      expect(s.metaTitle.length, id).toBeLessThanOrEqual(60);
      expect(s.metaDescription.length, id).toBeGreaterThanOrEqual(110);
      expect(s.metaDescription.length, id).toBeLessThanOrEqual(170);
      for (const text of [s.metaTitle, s.metaDescription]) {
        expect(text, id).not.toMatch(gated);
        expect(text, id).not.toMatch(/open[- ]source (reference )?app/i);
      }
    }
  });

  it('writes the record as the system actor, and never clobbers a person’s edit', async () => {
    const pageId = 'page:host-site-features';
    expect((await getSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId))?.updatedBy).toBe('system');
    await putSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, 'user:editor', { metaTitle: 'Hand-written title' });
    __resetSystemSiteSeoForTests();
    await ensureSystemSiteSeo();
    expect((await getSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId))?.metaTitle).toBe('Hand-written title');
    // restore for the other tests
    await putSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, 'system', SYSTEM_SITE_PAGE_SEO[pageId]! as unknown as Record<string, unknown>);
    __resetPublicReadCaches();
  });
});

describe('ADR 0824 D4/D5 — root robots.txt, sitemap.xml, llms.txt', () => {
  it('the root doors are on the anonymous allowlist', () => {
    for (const p of ['/llms.txt', '/robots.txt', '/sitemap.xml']) expect(isPublicPath(p), p).toBe(true);
  });

  it('/robots.txt: one group for every crawler incl. AI crawlers, app areas closed, sitemap at the root', async () => {
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = SYSTEM_SITE_ORG;
    const res = await get('/robots.txt', 'GPTBot/1.1');
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/plain');
    for (const ua of ['*', 'GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) expect(res.body).toContain(`User-agent: ${ua}\n`);
    // Versioned roots are derived from the majors served, never restated.
    const majors = protocolVersions().map((v) => `/v${v.split('.')[0]}/`);
    for (const p of ['/chat', '/admin', '/api/', ...majors]) expect(res.body).toContain(`Disallow: ${p}\n`);
    expect(res.body).toContain('Allow: /host/openwop-app/public\n');
    expect(res.body).toContain(`Sitemap: ${BASE}/sitemap.xml\n`);
    // One group: no blank line between the first User-agent and the last rule.
    const group = res.body.split('\n\n')[0]!;
    expect(group).toContain('Disallow: /inbox');
  });

  it('/robots.txt without a site org omits the Sitemap line', () => {
    expect(rootRobotsTxt('https://x.example', false)).not.toContain('Sitemap:');
  });

  it('/sitemap.xml lists public page URLs, never the JSON read', async () => {
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = SYSTEM_SITE_ORG;
    const res = await get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.type).toContain('application/xml');
    expect(res.body).toContain(`<loc>${BASE}/</loc>`);
    expect(res.body).toContain(`<loc>${BASE}/p/features</loc>`);
    expect(res.body).not.toContain('/public/host-site/pages/');
  });

  it('/sitemap.xml with no site org is an honest 404', async () => {
    expect((await get('/sitemap.xml')).status).toBe(404);
  });

  it('/llms.txt is public and opens with the one-paragraph definition', async () => {
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = SYSTEM_SITE_ORG;
    process.env.OPENWOP_DEMO_MODE = 'true';
    const res = await get('/llms.txt', 'ClaudeBot/1.0');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    expect(res.body.startsWith('# OpenWOP reference app\n\n> The reference app for OpenWOP, the open-source protocol for multi-agent workflow orchestration.')).toBe(true);
    for (const link of ['https://openwop.dev', 'https://openwop.dev/llms.txt', 'https://openwop.dev/ai-tools/']) expect(res.body).toContain(link);
    expect(res.body.indexOf('## Docs')).toBeGreaterThan(res.body.indexOf('ai-tools'));
  });
});

describe('CMS heading *emphasis* in crawler HTML (mirror of the SPA parser)', () => {
  it('matches only tight single-asterisk runs', () => {
    expect(parseHeadingEmphasis('watch, pause, and *rewind.*')).toEqual([
      { text: 'watch, pause, and ', em: false }, { text: 'rewind.', em: true },
    ]);
    for (const literal of ['**bold**', '* x *', '**', 'a * b', 'lone *', '2 * 3 * 4']) {
      expect(stripHeadingEmphasis(literal), literal).toBe(literal);
    }
    expect(headingEmphasisHtml('a *<b>*')).toBe('a <em>&lt;b&gt;</em>');
  });

  it('hero h1 and section h2 render <em>, ids and text carry no asterisks', () => {
    const hero = sectionHtml({ sectionId: 'h', type: 'hero', data: { heading: 'Pause and *rewind.*' } } as never, { assetBase: BASE })!;
    expect(hero).toContain('<h1>Pause and <em>rewind.</em></h1>');
    const rich = sectionHtml({ sectionId: 'r', type: 'richText', data: { heading: 'The *ledger*', text: 'x' } } as never, { assetBase: BASE })!;
    expect(rich).toContain('>The <em>ledger</em></h2>');
    expect(rich).not.toMatch(/id="[^"]*\*/);
    expect(rich).toContain('id="the-ledger"');
  });
});
