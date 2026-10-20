/**
 * ADR 0931 — the system site's profile, SEO seed, llms.txt head and optional
 * seeds are configurable per distribution:
 *  - unset, the OpenWOP profile is unchanged and still demo-gated (pinned in
 *    `public-site-aeo.test.ts`; re-checked here against the configured lane);
 *  - `OPENWOP_SYSTEM_SITE_PROFILE` replaces it, in or out of demo mode;
 *  - an invalid profile yields NO profile, never the OpenWOP one;
 *  - `OPENWOP_SYSTEM_SITE_SEEDS_DISABLED` stops the blog/docs/seo/marketing
 *    seeds writing anything.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getPage } from '../src/features/cms/cmsService.js';
import { getSeo, __resetPublicReadCaches } from '../src/features/publishing/publishingService.js';
import { ensureSystemSite, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from '../src/host/systemSite.js';
import { ensureSystemSiteBlog, LAUNCH_POST_PAGE_ID } from '../src/host/systemSiteBlog.js';
import { ensureSystemSiteDocs, SEEDED_DOC_SLUGS } from '../src/host/systemSiteDocs.js';
import { ensureSystemSiteSeo } from '../src/host/systemSiteSeo.js';
import { ensureMarketingContentPages } from '../src/host/marketingContentPages.js';
import { systemSiteLlmsPreamble, systemSiteProfile } from '../src/host/systemSiteProfile.js';
import {
  parseSiteProfile, systemSiteSeedEnabled, __resetSystemSiteConfigForTests,
} from '../src/host/systemSiteConfig.js';

const PROFILE = {
  siteName: 'Acme Agency',
  organizationSameAs: ['https://acme.example', 'https://www.linkedin.com/company/acme'],
  homeJsonLd: [{ '@type': 'SoftwareApplication', name: 'Acme Agency', applicationCategory: 'BusinessApplication' }],
  llms: { title: 'Acme Agency', summary: 'Campaign operations for agencies.', body: 'Plan, approve and ship client campaigns in one place.' },
};

let PORT = 0; let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // Set BEFORE boot: the boot ensures read it too.
  process.env.OPENWOP_SYSTEM_SITE_SEEDS_DISABLED = 'blog, docs,seo,MARKETING';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; res(); }); });
  await ensureSystemSite();
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => {
  delete process.env.OPENWOP_SYSTEM_SITE_PROFILE;
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
  __resetSystemSiteConfigForTests();
  __resetPublicReadCaches();
});

function get(path: string, ua: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { 'user-agent': ua } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}
const jsonLd = (html: string): any[] =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));

describe('ADR 0931 — OPENWOP_SYSTEM_SITE_PROFILE', () => {
  it('unset: the OpenWOP profile, demo-gated as before', () => {
    expect(systemSiteProfile(SYSTEM_SITE_ORG, 'home', 'https://x.test', 'd')).toBeNull();
    process.env.OPENWOP_DEMO_MODE = 'true';
    const p = systemSiteProfile(SYSTEM_SITE_ORG, 'home', 'https://x.test', 'd');
    expect(p?.siteName).toBe('OpenWOP');
    expect(p?.organizationSameAs).toEqual(['https://openwop.dev', 'https://github.com/openwop']);
    expect(systemSiteLlmsPreamble(SYSTEM_SITE_ORG)?.title).toBe('OpenWOP reference app');
  });

  it('inline JSON replaces the profile, in or out of demo mode, home blocks only on home', () => {
    process.env.OPENWOP_SYSTEM_SITE_PROFILE = JSON.stringify(PROFILE);
    for (const demo of [undefined, 'true']) {
      if (demo) process.env.OPENWOP_DEMO_MODE = demo;
      const home = systemSiteProfile(SYSTEM_SITE_ORG, 'home', 'https://x.test', 'd');
      expect(home).toEqual({
        siteName: 'Acme Agency',
        organizationSameAs: PROFILE.organizationSameAs,
        pageBlocks: [{ '@context': 'https://schema.org', ...PROFILE.homeJsonLd[0] }],
      });
      expect(systemSiteProfile(SYSTEM_SITE_ORG, 'about', 'https://x.test', 'd')?.pageBlocks).toEqual([]);
      expect(systemSiteLlmsPreamble(SYSTEM_SITE_ORG)).toEqual(PROFILE.llms);
    }
    // Another org is never touched.
    expect(systemSiteProfile('org-other', 'home', 'https://x.test', 'd')).toBeNull();
    expect(systemSiteLlmsPreamble('org-other')).toBeNull();
  });

  it('a file path works, and a profile without llms gives the generic llms head', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adr0931-'));
    const file = join(dir, 'site-profile.json');
    writeFileSync(file, JSON.stringify({ siteName: 'Acme Agency' }));
    process.env.OPENWOP_SYSTEM_SITE_PROFILE = file;
    process.env.OPENWOP_DEMO_MODE = 'true';
    expect(systemSiteProfile(SYSTEM_SITE_ORG, 'home', 'https://x.test', 'd'))
      .toEqual({ siteName: 'Acme Agency', organizationSameAs: [], pageBlocks: [] });
    expect(systemSiteLlmsPreamble(SYSTEM_SITE_ORG)).toBeNull();
  });

  it('an invalid profile yields no profile at all, never the OpenWOP one', () => {
    process.env.OPENWOP_DEMO_MODE = 'true';
    for (const bad of ['{not json', JSON.stringify({ organizationSameAs: [] }), '/nonexistent/adr0931.json',
      JSON.stringify({ siteName: 'A', organizationSameAs: ['javascript:alert(1)'] }),
      JSON.stringify({ siteName: 'A', homeJsonLd: [{ name: 'no type' }] }),
      JSON.stringify({ siteName: 'A', llms: { title: 'only a title' } })]) {
      __resetSystemSiteConfigForTests();
      process.env.OPENWOP_SYSTEM_SITE_PROFILE = bad;
      expect(systemSiteProfile(SYSTEM_SITE_ORG, 'home', 'https://x.test', 'd')).toBeNull();
      expect(systemSiteLlmsPreamble(SYSTEM_SITE_ORG)).toBeNull();
    }
  });

  it('parseSiteProfile names the reason', () => {
    expect(parseSiteProfile([])).toBe('not a JSON object');
    expect(parseSiteProfile({ siteName: ' ' })).toMatch(/siteName/);
  });

  it('the crawler home page carries the configured name, sameAs and JSON-LD', async () => {
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = SYSTEM_SITE_ORG;
    process.env.OPENWOP_SYSTEM_SITE_PROFILE = JSON.stringify(PROFILE);
    const res = await get('/', 'GPTBot/1.1');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<meta property="og:site_name" content="Acme Agency">');
    const blocks = jsonLd(res.body);
    // The seeded home COPY is still OpenWOP's until the distribution edits it;
    // the self-description must not be.
    expect(JSON.stringify(blocks)).not.toContain('openwop.dev');
    const org = blocks.find((b) => b['@type'] === 'Organization');
    expect(org?.name).toBe('Acme Agency');
    expect(org?.sameAs).toEqual(PROFILE.organizationSameAs);
    expect(blocks.find((b) => b['@type'] === 'SoftwareApplication')?.name).toBe('Acme Agency');
    expect(blocks.some((b) => b['@type'] === 'VideoObject')).toBe(false);
  });
});

describe('ADR 0931 — OPENWOP_SYSTEM_SITE_SEEDS_DISABLED', () => {
  it('parses a comma list, case- and space-insensitive', () => {
    for (const s of ['blog', 'docs', 'seo', 'marketing'] as const) expect(systemSiteSeedEnabled(s)).toBe(false);
    const prev = process.env.OPENWOP_SYSTEM_SITE_SEEDS_DISABLED;
    process.env.OPENWOP_SYSTEM_SITE_SEEDS_DISABLED = 'docs,typo';
    expect(systemSiteSeedEnabled('blog')).toBe(true);
    expect(systemSiteSeedEnabled('docs')).toBe(false);
    process.env.OPENWOP_SYSTEM_SITE_SEEDS_DISABLED = '';
    expect(systemSiteSeedEnabled('docs')).toBe(true);
    process.env.OPENWOP_SYSTEM_SITE_SEEDS_DISABLED = prev;
  });

  it('a disabled seed writes nothing: no launch post, no docs, no marketing pages, no seeded SEO', async () => {
    await Promise.all([ensureSystemSiteBlog(), ensureSystemSiteDocs(), ensureMarketingContentPages(), ensureSystemSiteSeo()]);
    expect(await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID)).toBeNull();
    for (const slug of SEEDED_DOC_SLUGS) {
      expect(await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, `page:host-site-docs-${slug}`)).toBeNull();
    }
    for (const slug of ['about', 'roadmap', 'changelog', 'support', 'claude-code']) {
      expect(await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, `page:host-site-${slug}`)).toBeNull();
    }
    // The home page itself is always seeded (it also creates the org); only its
    // seeded SEO record is skipped.
    expect(await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, 'page:host-site-home')).not.toBeNull();
    expect(await getSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, 'page:host-site-home')).toBeNull();
  });
});
