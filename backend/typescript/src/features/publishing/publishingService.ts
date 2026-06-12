/**
 * Publishing & SEO (ADR 0012). COMPOSES the CMS (ADR 0009) — it never modifies
 * CMS data. It owns per-page SEO metadata + the PUBLIC distribution surface
 * (published-page read, sitemap, robots, RSS). A public visitor is
 * unauthenticated: the org comes from the URL, its tenant from `getOrg`, and the
 * surface is gated on the org-tenant's `publishing` toggle + served published-only.
 *
 * @see docs/adr/0012-publishing-seo.md
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { optionalCleanString, safeUrl, escapeXml } from '../../host/boundedStrings.js';
import { getOrg } from '../../host/accessControlService.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { createLogger } from '../../observability/logger.js';
import { getPage, getPublishedBySlug, listPages, type Page, type Section } from '../cms/cmsService.js';

const log = createLogger('features.publishing');

const MAX = {
  metaTitle: 200,
  metaDescription: 320,
  ogTitle: 200,
  ogDescription: 320,
  url: 2048,
  token: 512,
  /** Cap on URLs emitted in sitemap.xml / feed.rss — these are PUBLIC,
   *  unauthenticated endpoints, so the response size must be bounded (the
   *  sitemaps spec caps a single file at 50k URLs). */
  publicListUrls: 5000,
} as const;

export interface PageSeo {
  tenantId: string;
  orgId: string;
  pageId: string;
  metaTitle?: string;
  metaDescription?: string;
  ogTitle?: string;
  ogDescription?: string;
  /** An opaque Media-asset serve token (ADR 0007); intended-public (social cards). */
  ogImageToken?: string;
  canonicalUrl?: string;
  noindex: boolean;
  updatedBy: string;
  updatedAt: string;
}

const seoStore = new DurableCollection<PageSeo>('publishing:seo', (s) => `${s.tenantId}:${s.orgId}:${s.pageId}`);

// ─── authed SEO CRUD (composes cmsService for the page-ownership check) ───────

export async function getSeo(tenantId: string, orgId: string, pageId: string): Promise<PageSeo | null> {
  const page = await getPage(tenantId, orgId, pageId);
  if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId });
  return seoStore.get(`${tenantId}:${orgId}:${pageId}`);
}

export async function putSeo(
  tenantId: string,
  orgId: string,
  pageId: string,
  actor: string,
  input: Record<string, unknown>,
): Promise<PageSeo> {
  // The page MUST exist in THIS org (cross-page/org id fails closed).
  const page = await getPage(tenantId, orgId, pageId);
  if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId });

  const ogImageToken = await validateOgImageToken(input.ogImageToken, tenantId);
  const canonical = input.canonicalUrl == null || input.canonicalUrl === ''
    ? undefined
    : safeUrl(String(input.canonicalUrl), MAX.url);
  if (input.canonicalUrl && !canonical) {
    throw new OpenwopError('validation_error', '`canonicalUrl` must be a safe http(s) URL.', 400, { field: 'canonicalUrl' });
  }

  const next: PageSeo = {
    tenantId,
    orgId,
    pageId,
    ...defined('metaTitle', optionalCleanString(input.metaTitle, MAX.metaTitle)),
    ...defined('metaDescription', optionalCleanString(input.metaDescription, MAX.metaDescription)),
    ...defined('ogTitle', optionalCleanString(input.ogTitle, MAX.ogTitle)),
    ...defined('ogDescription', optionalCleanString(input.ogDescription, MAX.ogDescription)),
    ...defined('ogImageToken', ogImageToken),
    ...defined('canonicalUrl', canonical),
    noindex: input.noindex === true,
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  await seoStore.put(next);
  return next;
}

// ─── public surface (unauthed — org→tenant from URL, toggle-gated) ────────────

/** Resolve the org's tenant for the public surface. ADR 0027: Publishing is
 *  always-on, so there is NO per-tenant toggle gate here — the CMS editorial
 *  `published` status is the sole public gate (`getPublishedBySlug` is
 *  published-only; Sharing covers private/draft access). 404 only for an
 *  unknown org. */
async function resolvePublicOrg(orgId: string): Promise<string> {
  const org = await getOrg(orgId);
  if (!org) throw new OpenwopError('not_found', 'Site not found.', 404, { orgId });
  return org.tenantId;
}

export interface PublicPage {
  slug: string;
  title: string;
  sections: Section[];
  publishedVersion?: number;
  updatedAt: string;
  redirectedFrom?: string;
  seo: {
    title: string;
    description: string;
    canonicalUrl: string;
    ogTitle: string;
    ogDescription: string;
    ogImageUrl?: string;
    noindex: boolean;
  };
}

export async function publicPageBySlug(orgId: string, slug: string, baseUrl: string): Promise<PublicPage> {
  const tenantId = await resolvePublicOrg(orgId);
  const hit = await getPublishedBySlug(tenantId, orgId, slug);
  if (!hit) throw new OpenwopError('not_found', 'Page not found.', 404, { slug });
  const seo = await seoStore.get(`${tenantId}:${orgId}:${hit.page.pageId}`);
  return projectPublic(hit.page, seo, orgId, baseUrl, hit.redirectedFrom);
}

/** Published pages for an org's public surface (sitemap/feed), excluding
 *  `noindex` pages from indexable outputs (the caller filters per output). Reads
 *  the org's SEO rows in ONE store scan + a map, NOT a get() per page — this is
 *  a public, unauthenticated path that must not fan out N storage reads/request. */
async function listPublishedWithSeo(orgId: string): Promise<Array<{ page: Page; seo: PageSeo | null }>> {
  const tenantId = await resolvePublicOrg(orgId);
  const published = (await listPages(tenantId, orgId)).filter((p) => p.status === 'published');
  const seoByPage = new Map<string, PageSeo>();
  for (const s of await seoStore.list()) {
    if (s.tenantId === tenantId && s.orgId === orgId) seoByPage.set(s.pageId, s);
  }
  return published.map((page) => ({ page, seo: seoByPage.get(page.pageId) ?? null }));
}

/** Cap a public list to `MAX.publicListUrls` (bounded response on an unauthed
 *  endpoint), logging when it truncates so the drop isn't silent. */
function capPublic<T>(rows: T[], orgId: string, surface: string): T[] {
  if (rows.length <= MAX.publicListUrls) return rows;
  log.warn('public_list_truncated', { orgId, surface, total: rows.length, cap: MAX.publicListUrls });
  return rows.slice(0, MAX.publicListUrls);
}

export async function sitemapXml(orgId: string, baseUrl: string): Promise<string> {
  const rows = capPublic(
    (await listPublishedWithSeo(orgId)).filter(({ seo }) => !seo?.noindex).sort((a, b) => (a.page.slug < b.page.slug ? -1 : 1)),
    orgId, 'sitemap',
  );
  const urls = rows
    .map(({ page }) => `  <url>\n    <loc>${escapeXml(pageUrl(baseUrl, orgId, page.slug))}</loc>\n    <lastmod>${escapeXml(page.updatedAt)}</lastmod>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export async function robotsTxt(orgId: string, baseUrl: string): Promise<string> {
  // Touch the toggle gate so robots.txt for a publishing-off org 404s too.
  await resolvePublicOrg(orgId);
  const sitemap = `${baseUrl}/v1/host/sample/public/${encodeURIComponent(orgId)}/sitemap.xml`;
  return `User-agent: *\nAllow: /\nSitemap: ${sitemap}\n`;
}

export async function feedRss(orgId: string, baseUrl: string): Promise<string> {
  const rows = capPublic(
    (await listPublishedWithSeo(orgId)).filter(({ seo }) => !seo?.noindex).sort((a, b) => (a.page.updatedAt < b.page.updatedAt ? 1 : -1)),
    orgId, 'feed',
  );
  const items = rows
    .map(({ page, seo }) => {
      const link = pageUrl(baseUrl, orgId, page.slug);
      const title = seo?.metaTitle ?? page.title;
      const desc = seo?.metaDescription ?? descriptionFrom(page);
      return `    <item>\n      <title>${escapeXml(title)}</title>\n      <link>${escapeXml(link)}</link>\n      <guid isPermaLink="true">${escapeXml(link)}</guid>\n      <pubDate>${escapeXml(new Date(page.updatedAt).toUTCString())}</pubDate>\n      <description>${escapeXml(desc)}</description>\n    </item>`;
    })
    .join('\n');
  const self = `${baseUrl}/v1/host/sample/public/${encodeURIComponent(orgId)}/feed.rss`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${escapeXml(orgId)}</title>\n    <link>${escapeXml(`${baseUrl}/v1/host/sample/public/${encodeURIComponent(orgId)}`)}</link>\n    <description>Published pages</description>\n    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(self)}" rel="self" type="application/rss+xml" />\n${items}\n  </channel>\n</rss>\n`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function projectPublic(page: Page, seo: PageSeo | null, orgId: string, baseUrl: string, redirectedFrom?: string): PublicPage {
  const description = seo?.metaDescription ?? descriptionFrom(page);
  const out: PublicPage = {
    slug: page.slug,
    title: page.title,
    sections: page.sections,
    ...(page.publishedVersion !== undefined ? { publishedVersion: page.publishedVersion } : {}),
    updatedAt: page.updatedAt,
    ...(redirectedFrom ? { redirectedFrom } : {}),
    seo: {
      title: seo?.metaTitle ?? page.title,
      description,
      canonicalUrl: seo?.canonicalUrl ?? pageUrl(baseUrl, orgId, page.slug),
      ogTitle: seo?.ogTitle ?? seo?.metaTitle ?? page.title,
      ogDescription: seo?.ogDescription ?? description,
      noindex: seo?.noindex ?? false,
      ...(seo?.ogImageToken ? { ogImageUrl: `${baseUrl}/v1/host/sample/assets/${encodeURIComponent(seo.ogImageToken)}` } : {}),
    },
  };
  return out;
}

/** A description fallback from the first hero/richText section text, bounded. */
function descriptionFrom(page: Page): string {
  for (const s of page.sections) {
    const d = s.data as Record<string, unknown>;
    const text = typeof d.subheading === 'string' ? d.subheading
      : typeof d.text === 'string' ? d.text
        : typeof d.heading === 'string' ? d.heading : '';
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed.slice(0, MAX.metaDescription);
  }
  return page.title;
}

function pageUrl(baseUrl: string, orgId: string, slug: string): string {
  return `${baseUrl}/v1/host/sample/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`;
}

/** A media token is a base64url capability + an intended-public OG image — NOT
 *  cleanString (which would secret-scrub it). Validate charset/length, and that
 *  it resolves to an asset in the caller's tenant (no dangling/foreign refs). */
async function validateOgImageToken(raw: unknown, tenantId: string): Promise<string | undefined> {
  if (raw == null) return undefined;
  const token = String(raw).trim();
  if (token === '') return undefined; // trim BEFORE the empty check — whitespace clears, doesn't 400
  if (token.length > MAX.token || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new OpenwopError('validation_error', 'Invalid `ogImageToken`.', 400, { field: 'ogImageToken' });
  }
  const asset = await resolveMediaAsset(token);
  if (!asset || asset.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'OG image asset not found.', 404, { field: 'ogImageToken' });
  }
  return token;
}

/** Spread-helper: include a key only when its value is defined (exactOptionalPropertyTypes). */
function defined<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
