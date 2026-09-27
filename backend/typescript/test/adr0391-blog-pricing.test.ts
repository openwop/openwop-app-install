/**
 * ADR 0391 — blog taxonomy + public pricing route gates:
 *  - the public blog list returns PUBLISHED POSTS only (a draft post and an
 *    ordinary page are both excluded) and narrows by tag / category / author;
 *  - the blog RSS is author-enriched (xmlns:dc + <dc:creator> + <category>) and
 *    excludes non-post pages;
 *  - /public/pricing returns the tier catalog WITHOUT any Stripe id and honors
 *    OPENWOP_BILLING_PLAN_DISPLAY (honest-when-unconfigured);
 *  - the `pricing` CMS section validates and renders through the prerender route.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ensureMarketingLegalPages, countMarketingLegalPages, __resetMarketingLegalEnsure } from '../src/host/marketingLegalPages.js';
import { getPage } from '../src/features/cms/cmsService.js';
import { getOrg } from '../src/host/accessControlService.js';
import { readingMinutesFor } from '../src/features/publishing/publishingService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';

let BASE: string; let PORT = 0; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  const d = getToggleDefault('users');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_BILLING_PLAN_DISPLAY; delete process.env.OPENWOP_SEO_PRERENDER_DISABLED; });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}

/** Raw GET returning raw text (for the XML feed + prerender HTML). */
function rawGet(path: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const cms = (orgId: string, sfx = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${sfx}`;

/** Create a page of the given facets and (optionally) publish it. */
async function makePage(owner: ReturnType<typeof client>, orgId: string, body: Record<string, unknown>, publish: boolean): Promise<{ pageId: string; slug: string }> {
  const created = await owner.post(cms(orgId, '/pages'), body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const pageId = created.body.pageId as string;
  if (publish) expect((await owner.post(cms(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
  return { pageId, slug: created.body.slug as string };
}

/** An org seeded with two published posts, one plain published page, one draft post. */
async function blogOrg(): Promise<{ orgId: string; pageTitle: string }> {
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `blog-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Blog Co' });
  const orgId = org.body.orgId as string;

  await makePage(owner, orgId, {
    title: 'First Post', kind: 'post', category: 'Engineering', authorId: 'author-1', tags: ['Alpha'],
    sections: [{ type: 'hero', data: { heading: 'First Post', subheading: 'An intro paragraph.' } }],
  }, true);
  await makePage(owner, orgId, {
    title: 'Second Post', kind: 'post', category: 'Product', tags: ['Beta'],
    sections: [{ type: 'hero', data: { heading: 'Second Post', subheading: 'Another intro.' } }],
  }, true);
  const pageTitle = 'Plain Page Only';
  await makePage(owner, orgId, { title: pageTitle, sections: [{ type: 'hero', data: { heading: pageTitle } }] }, true);
  await makePage(owner, orgId, { title: 'Draft Post', kind: 'post', sections: [{ type: 'hero', data: { heading: 'Draft Post' } }] }, false);

  return { orgId, pageTitle };
}

const blog = (orgId: string, qs = ''): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/blog${qs}`;

describe('ADR 0391 — public blog list', () => {
  it('returns PUBLISHED POSTS only (excludes a draft post and an ordinary page)', async () => {
    const { orgId } = await blogOrg();
    const anon = client();
    const r = await anon.get(blog(orgId));
    expect(r.status).toBe(200);
    const titles = (r.body.posts as Array<{ title: string }>).map((p) => p.title);
    expect(titles).toContain('First Post');
    expect(titles).toContain('Second Post');
    expect(titles).not.toContain('Plain Page Only'); // kind:'page'
    expect(titles).not.toContain('Draft Post');       // unpublished
    // newest-first by updatedAt (Second Post published after First Post)
    expect(titles).toEqual(['Second Post', 'First Post']);
    // projection carries the facets + an excerpt, never draft section internals
    const first = (r.body.posts as Array<Record<string, unknown>>).find((p) => p.title === 'First Post')!;
    expect(first.category).toBe('engineering'); // slugified
    expect(first.tags).toEqual(['alpha']);
    expect(first.authorId).toBe('author-1');
    expect(typeof first.excerpt).toBe('string');
    expect(String(first.publishedAt)).toMatch(/\dT/);
  });

  it('narrows by tag, category, and author', async () => {
    const { orgId } = await blogOrg();
    const anon = client();
    const byTag = await anon.get(blog(orgId, '?tag=alpha'));
    expect((byTag.body.posts as Array<{ title: string }>).map((p) => p.title)).toEqual(['First Post']);
    const byCat = await anon.get(blog(orgId, '?category=product'));
    expect((byCat.body.posts as Array<{ title: string }>).map((p) => p.title)).toEqual(['Second Post']);
    const byAuthor = await anon.get(blog(orgId, '?author=author-1'));
    expect((byAuthor.body.posts as Array<{ title: string }>).map((p) => p.title)).toEqual(['First Post']);
  });

  it('unknown org is a uniform 404', async () => {
    expect((await client().get(blog('org-does-not-exist'))).status).toBe(404);
  });
});

// ── UX_UPGRADE-site G2/G7 — the blog card's reading estimate + cover ──────────

describe('blog projection — readingMinutes + coverImageToken', () => {
  it('reading time is floored at 1 and GROWS with the published body', async () => {
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: `blog-read-${Date.now()}-${n++}@acme.test` });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Reading Co' })).body.orgId as string;

    // ~1000 words of prose → ≈4 min at 225 wpm; the short post floors at 1.
    const long = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
    await makePage(owner, orgId, {
      title: 'Short Post', kind: 'post',
      sections: [{ type: 'hero', data: { heading: 'Short Post', subheading: 'Two words.' } }],
    }, true);
    await makePage(owner, orgId, {
      title: 'Long Post', kind: 'post',
      sections: [{ type: 'richText', data: { heading: 'Long Post', text: long } }],
    }, true);

    const posts = (await client().get(blog(orgId))).body.posts as Array<{ title: string; readingMinutes: number }>;
    const short = posts.find((p) => p.title === 'Short Post')!;
    const longer = posts.find((p) => p.title === 'Long Post')!;
    expect(short.readingMinutes).toBe(1);
    expect(longer.readingMinutes).toBeGreaterThan(short.readingMinutes);
    expect(longer.readingMinutes).toBe(4); // 1000 body words + a 2-word heading @225wpm
  });

  it('bounds the walk so one enormous page cannot make the public list read expensive', () => {
    // CMS validation already bounds a single section's text, so this exercises
    // the guard directly: 60k words across many sections saturates at the
    // 30k-word cap (133 min) instead of walking every word.
    const chunk = Array.from({ length: 2_000 }, (_, i) => `w${i}`).join(' ');
    const sections = Array.from({ length: 30 }, (_, i) => ({
      sectionId: `s${i}`, type: 'richText' as const, data: { text: chunk },
    }));
    expect(readingMinutesFor({ sections })).toBe(133); // 30000 / 225, saturated — not 267

    // …and a page UNDER the cap is still counted exactly, so the guard is a
    // ceiling, not a blanket.
    expect(readingMinutesFor({ sections: sections.slice(0, 2) })).toBe(18); // 4000 / 225
  });

  it('a NON-prose field (asset token, url, icon slug) never inflates the estimate', async () => {
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: `blog-nonprose-${Date.now()}-${n++}@acme.test` });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Non-prose Co' })).body.orgId as string;
    const noise = Array.from({ length: 1000 }, (_, i) => `tok${i}`).join(' ');
    await makePage(owner, orgId, {
      title: 'Noisy Post', kind: 'post',
      sections: [{ type: 'hero', data: { heading: 'Noisy Post', ctaUrl: noise, ctaUrl2: noise } }],
    }, true);
    const posts = (await client().get(blog(orgId))).body.posts as Array<{ readingMinutes: number }>;
    expect(posts[0]!.readingMinutes).toBe(1);
  });

  it('projects the post’s OG image token as the card cover — and omits it when unset', async () => {
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: `blog-cover-${Date.now()}-${n++}@acme.test` });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Cover Co' })).body.orgId as string;
    const org = await getOrg(orgId);
    const withCover = await makePage(owner, orgId, { title: 'Has Cover', kind: 'post', sections: [{ type: 'hero', data: { heading: 'Has Cover' } }] }, true);
    await makePage(owner, orgId, { title: 'No Cover', kind: 'post', sections: [{ type: 'hero', data: { heading: 'No Cover' } }] }, true);

    const { token: serveToken } = await storeMediaAsset(org!.tenantId, { contentBase64: Buffer.from('png').toString('base64'), contentType: 'image/png' });
    const put = await owner.put(`/v1/host/openwop-app/publishing/orgs/${encodeURIComponent(orgId)}/pages/${withCover.pageId}/seo`, { ogImageToken: serveToken });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const posts = (await client().get(blog(orgId))).body.posts as Array<{ title: string; coverImageToken?: string }>;
    expect(posts.find((p) => p.title === 'Has Cover')!.coverImageToken).toBe(serveToken);
    expect(posts.find((p) => p.title === 'No Cover')!.coverImageToken).toBeUndefined();
  });
});

describe('ADR 0391 — blog RSS (author-enriched, post-scoped)', () => {
  it('declares xmlns:dc + emits <dc:creator> and <category>, and excludes non-post pages', async () => {
    const { orgId, pageTitle } = await blogOrg();
    const res = await rawGet(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/blog/feed.xml`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('rss');
    expect(res.body).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(res.body).toContain('<dc:creator>');
    expect(res.body).toContain('<category>engineering</category>');
    expect(res.body).toContain('First Post');
    // an ordinary (kind:'page') page never appears in the blog feed
    expect(res.body).not.toContain(pageTitle);
  });
});

describe('ADR 0391 (BLOG-2) — editing a published post does NOT re-float it', () => {
  it('blog order + RSS pubDate track the PUBLISH instant, not updatedAt', async () => {
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: `blog-refloat-${Date.now()}-${n++}@acme.test` });
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Refloat Co' });
    const orgId = org.body.orgId as string;

    // First is published BEFORE Second → Second sorts newest-first.
    const first = await makePage(owner, orgId, { title: 'First Post', kind: 'post', sections: [{ type: 'hero', data: { heading: 'First Post' } }] }, true);
    await makePage(owner, orgId, { title: 'Second Post', kind: 'post', sections: [{ type: 'hero', data: { heading: 'Second Post' } }] }, true);

    // Edit the (already published) First Post — this bumps its `updatedAt` to be
    // the newest of the two, but must NOT change its `publishedAt`. The org owner
    // holds host:members:manage, so editing a published page succeeds.
    const put = await owner.patch(cms(orgId, `/pages/${first.pageId}`), { sections: [{ type: 'hero', data: { heading: 'First Post (edited)' } }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const anon = client();
    const list = await anon.get(blog(orgId));
    const titles = (list.body.posts as Array<{ title: string }>).map((p) => p.title);
    // First did NOT re-float despite a newer updatedAt — publishedAt drives order.
    expect(titles).toEqual(['Second Post', 'First Post']);

    const feed = await rawGet(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/blog/feed.xml`);
    expect(feed.body.indexOf('Second Post')).toBeLessThan(feed.body.indexOf('First Post'));
  });
});

describe('R2-BLOG-3 — the blog projection honors Accept-Language', () => {
  it('localizes excerpts + reading estimates via the page-view negotiation; base without the header', async () => {
    // Authoring locales needs the (default-OFF) cms-localization toggle.
    const loc = getToggleDefault('cms-localization');
    if (loc) await saveConfig({ ...loc, status: 'on' }, 'test');
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: `blog-l10n-${Date.now()}-${n++}@acme.test` });
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'L10n Blog Co' });
    const orgId = org.body.orgId as string;
    expect((await owner.put(cms(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] })).status).toBe(200);
    await makePage(owner, orgId, {
      title: 'Hello', kind: 'post',
      sections: [{ type: 'richText', data: { text: 'The base excerpt' }, localizations: { 'pt-BR': { text: 'O resumo localizado' } } }],
    }, true);

    const url = `${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/blog`;
    const base = await (await fetch(url)).json() as { posts: Array<{ excerpt: string; title: string }> };
    expect(base.posts[0]!.excerpt).toBe('The base excerpt');

    const br = await (await fetch(url, { headers: { 'accept-language': 'pt-BR' } })).json() as { posts: Array<{ excerpt: string; title: string }> };
    expect(br.posts[0]!.excerpt).toBe('O resumo localizado');
    // Title stays base BY DESIGN — localizePage never localizes the title
    // field (the page view serves the base title too, so cards and pages agree).
    expect(br.posts[0]!.title).toBe('Hello');
  });
});

describe('ADR 0391 — public pricing catalog', () => {
  it('returns the tier catalog with NO Stripe id, and is cacheable', async () => {
    const res = await rawGet('/v1/host/openwop-app/public/pricing');
    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control'])).toContain('max-age=300');
    expect(res.body.toLowerCase()).not.toContain('stripe');
    expect(res.body).not.toContain('priceId');
    const parsed = JSON.parse(res.body) as { tiers: Array<{ tier: string; name: string; display?: unknown }> };
    expect(parsed.tiers.map((t) => t.tier)).toEqual(['free', 'pro', 'team', 'enterprise']);
    // unconfigured ⇒ no fabricated price (no display block)
    expect(parsed.tiers.every((t) => t.display === undefined)).toBe(true);
  });

  it('honors OPENWOP_BILLING_PLAN_DISPLAY (and ignores malformed tier entries)', async () => {
    process.env.OPENWOP_BILLING_PLAN_DISPLAY = JSON.stringify({ pro: { price: '$29', cadence: '/mo', highlighted: true }, team: 'not-an-object' });
    const client_ = client();
    const r = await client_.get('/v1/host/openwop-app/public/pricing');
    const tiers = r.body.tiers as Array<{ tier: string; display?: { price?: string; highlighted?: boolean } }>;
    const pro = tiers.find((t) => t.tier === 'pro')!;
    expect(pro.display?.price).toBe('$29');
    expect(pro.display?.highlighted).toBe(true);
    // a non-object entry is skipped, not fatal
    expect(tiers.find((t) => t.tier === 'team')!.display).toBeUndefined();
  });

  // R2-G7 (UX_UPGRADE-site round 2) — the ADDITIVE annual price shape behind the
  // pricing page's monthly/annual toggle. All optional; bounded like the rest.
  it('carries priceAnnual/cadenceAnnual/annualNote when authored — bounded, never invented', async () => {
    process.env.OPENWOP_BILLING_PLAN_DISPLAY = JSON.stringify({
      pro: { price: '$29', cadence: '/mo', priceAnnual: '$290', cadenceAnnual: '/yr', annualNote: 'Two months free on yearly' },
      free: { price: '$0', cadence: '/mo', annualNote: 'x'.repeat(200) }, // over the 80-char bound
    });
    const r = await client().get('/v1/host/openwop-app/public/pricing');
    const tiers = r.body.tiers as Array<{ tier: string; display?: { priceAnnual?: string; cadenceAnnual?: string; annualNote?: string } }>;
    const pro = tiers.find((t) => t.tier === 'pro')!;
    expect(pro.display?.priceAnnual).toBe('$290');
    expect(pro.display?.cadenceAnnual).toBe('/yr');
    expect(pro.display?.annualNote).toBe('Two months free on yearly');
    const free = tiers.find((t) => t.tier === 'free')!;
    expect(free.display?.priceAnnual).toBeUndefined(); // not authored ⇒ not fabricated
    expect(free.display?.annualNote?.length).toBe(80); // bounded
  });
});

describe('ADR 0391 — pricing CMS section', () => {
  it('validates the pricing section and renders it via the prerender route', async () => {
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: `price-${Date.now()}-${n++}@acme.test` });
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Pricing Co' });
    const orgId = org.body.orgId as string;
    const { slug } = await makePage(owner, orgId, {
      title: 'Pricing',
      sections: [{ type: 'pricing', data: { heading: 'Plans', blurb: 'Pick a plan.', tiers: ['free', 'pro', 'bogus'], ctaLabel: 'Compare', ctaUrl: '/pricing' } }],
    }, true);

    // closed-enum validation dropped the bogus tier; kept the valid subset
    const page = await owner.get(cms(orgId, `/pages/by-slug/${slug}`));
    const section = (page.body.page.sections as Array<{ type: string; data: Record<string, unknown> }>).find((s) => s.type === 'pricing')!;
    expect(section.data.tiers).toEqual(['free', 'pro']);

    // renders through the ONE server section renderer (semantic stub: heading + CTA)
    const pre = await rawGet(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/prerender/${encodeURIComponent(slug)}`);
    expect(pre.status).toBe(200);
    expect(pre.body).toContain('<h2 id="plans">Plans</h2>'); // R2-D10 — headings carry stable anchor ids
    expect(pre.body).toContain('<a href="/pricing">Compare</a>');
  });
});

describe('ADR 0391 — marketing + legal seed set', () => {
  it('seeds host-global DRAFT pages, idempotently, with counsel-placeholder legal bodies', async () => {
    __resetMarketingLegalEnsure();
    const first = await ensureMarketingLegalPages();
    // 4 marketing + 16 legal + trust (ADR 0416). About/Roadmap/Changelog/Support
    // moved to the real/published set in marketingContentPages.ts (ADR 0486 f/u).
    expect(first.created).toBe(21);
    expect(await countMarketingLegalPages()).toBe(21);

    // idempotent: a second ensure creates nothing new
    __resetMarketingLegalEnsure();
    expect((await ensureMarketingLegalPages()).created).toBe(0);

    // legal pages land DRAFT and open with the counsel placeholder
    const privacy = await getPage('host:site', 'host-site', 'page:host-site-privacy');
    expect(privacy?.status).toBe('draft');
    const body = privacy?.sections.find((s) => s.type === 'richText')?.data.text as string;
    expect(body.startsWith('[PLACEHOLDER — review by counsel before publishing]')).toBe(true);
  });
});
