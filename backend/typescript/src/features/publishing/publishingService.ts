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
import { getPage, getPublishedBySlug, getVersion, listPages, getContentLanguageSettings, localizePage, resolveSharedRefs, type Page, type PageListFilter, type Section } from '../cms/cmsService.js';
// ADR 0593 D1 — the ONE approval-gate predicate (see the class-enumeration note
// in `putSeo`). Publishing already depends on cms for its page reads.
import { liveEditRefusal, refuseLiveEdit } from '../cms/contentApproval.js';
import { negotiateLocale } from '../../host/i18n/index.js';
import { resolveSubjectDisplays } from '../../host/subjectDisplay.js';
import { userRef } from '../../host/conversationStore.js';
// ADR 0236 (campaign gap D1) — the visitor-scoped experiment assignment seam.
// Publishing COMPOSES the CMS experiment config (read-only) and the ONE consent
// rule (ADR 0020, the analytics beacon's gate) — it never stores anything.
import { assignVariantForVisitor, findRunningExperiment } from '../cms/pageExperimentsService.js';
import { isAllowed } from '../consent/consentService.js';
import { TtlLruCache, publicListTtlMs } from './publicReadCache.js';
import { vendorPublicBase } from '../featureRoute.js';

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

  // ADR 0593 D1, class enumeration — SEO metadata is the SECOND read-time
  // indirection into a published page, found by enumerating the class the
  // shared-section Blocker (`CMSA-1`) belongs to rather than fixing only the
  // instance. It is read at DELIVERY (`publicPageBySlug` → `projectPublic`), it
  // is never covered by the approval's `page.version` pin, and it is
  // `workspace:write` — so on a gated org an editor could rewrite a live page's
  // `<title>`, description, og image and canonical URL with the Approvals inbox
  // empty, which is exactly the promise `cms-approval-gate` makes to the org.
  //
  // Same remedy and same exemption as the CMS lanes: unpublish first; the
  // reserved system-site org has no members and no approvers, so gating it there
  // would make the marketing site unrecoverable (the CMS2-B1 correction).
  //
  // CORRECTED (adversarial review F1): this refused only on `published`, while
  // its sibling shared-section gate refused on `published` OR `in_review`. The
  // pin blindness is identical — `putSeo` never moves `page.version` — so with
  // the gate ON a `workspace:write` editor could rewrite the canonical URL,
  // title, og image or `noindex` of a page ALREADY UNDER REVIEW, and the approve
  // shipped them: the reviewer signed off a body while the head changed
  // underneath. Both arms now come from the ONE shared rule.
  if (await refuseLiveEdit(tenantId, orgId, page.status)) {
    throw liveEditRefusal(
      'this page’s SEO metadata',
      [{ pageId: page.pageId, title: page.title, status: page.status }],
      { pageId, status: page.status },
    );
  }

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
  /** ADR 0236 (D1) — ADDITIVE experiment stamp: present only when a running
   *  experiment assigned this (consented) visitor a variant. The renderer
   *  echoes it onto its analytics beacon events (`experiment: {id, variant}`). */
  experiment?: { experimentId: string; variant: string };
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

export async function publicPageBySlug(
  orgId: string,
  slug: string,
  baseUrl: string,
  acceptLanguage?: string | null,
  vk?: string | null,
): Promise<{ page: PublicPage; locale: string }> {
  const tenantId = await resolvePublicOrg(orgId);
  const hit = await getPublishedBySlug(tenantId, orgId, slug);
  if (!hit) throw new OpenwopError('not_found', 'Page not found.', 404, { slug });

  // ADR 0236 (D1) — visitor-scoped experiment assignment. ONLY when the caller
  // sent a bounded visitor key (`vk` = the analytics beacon sessionKey) AND a
  // RUNNING experiment covers this page AND the visitor's analytics consent
  // passes (the SAME `isAllowed` gate the beacon uses — no key/consent ⇒
  // exactly today's published page, no experiment exposure). A variant with a
  // versionId serves THAT PageVersion's snapshot (title/sections — the
  // restoreVersion read); the null-versionId HOLDOUT serves the published
  // content but is still stamped/tracked.
  let servedPage = hit.page;
  let experimentStamp: { experimentId: string; variant: string } | undefined;
  const visitorKey = typeof vk === 'string' && vk.length > 0 && vk.length <= MAX.token ? vk : '';
  if (visitorKey) {
    const experiment = await findRunningExperiment(tenantId, orgId, hit.page.pageId);
    if (experiment && (await isAllowed(tenantId, visitorKey, 'analytics'))) {
      const variant = assignVariantForVisitor(experiment, visitorKey);
      if (variant && variant.versionId === null) {
        experimentStamp = { experimentId: experiment.experimentId, variant: variant.key };
      } else if (variant && variant.versionId !== null) {
        const version = await getVersion(tenantId, orgId, hit.page.pageId, variant.versionId);
        if (version) {
          // The snapshot read mirrors restoreVersion (title + sections; the
          // LIVE slug/status stay). Shared refs resolve like any delivery.
          servedPage = await resolveSharedRefs({ ...hit.page, title: version.snapshot.title, sections: version.snapshot.sections });
          experimentStamp = { experimentId: experiment.experimentId, variant: variant.key };
        } else {
          // Snapshot aged out mid-experiment — degrade to the published page
          // WITHOUT a stamp (never attribute content the visitor didn't see).
          log.warn('experiment_variant_version_missing', { orgId, pageId: hit.page.pageId, experimentId: experiment.experimentId, variant: variant.key });
        }
      }
    }
  }

  // ADR 0064 — resolve sections for the locale negotiated from Accept-Language
  // (anonymous browsers send it automatically). No authored locales ⇒ base
  // verbatim. The negotiated locale is a response concern (Content-Language).
  const settings = await getContentLanguageSettings(tenantId, orgId);
  const { page: localized, locale } = localizePage(servedPage, acceptLanguage, settings);
  const seo = await seoStore.get(`${tenantId}:${orgId}:${hit.page.pageId}`);
  return { page: projectPublic(localized as Page, seo, orgId, baseUrl, hit.redirectedFrom, experimentStamp), locale };
}

/** The locale a public request negotiates for this org, from Accept-Language
 *  alone (settings-based — per-page draft-locale withholding is not consulted).
 *  Used as the crawler-prerender memo KEY (SEO-2): it collapses the unbounded
 *  Accept-Language header space to the org's small authored-locale set, so the
 *  HTML memo keys by `(orgId, slug, negotiated-locale)` without loading the page.
 *  UX_UPGRADE-publishing R2 (PUB2-B1) — this used to `catch { return 'en' }`,
 *  defended by the note that "the render itself still performs the
 *  authoritative negotiation". That mitigation is real and it is exactly what
 *  hid the defect: the render IS correct, so the page the first visitor gets is
 *  right — and is then stored under a key that no longer describes it.
 *
 *  The value is not a per-request answer, it is a shared CACHE KEY. While the
 *  settings read is failing, EVERY visitor's key collapses to `'en'` whatever
 *  their Accept-Language, so the first miss stores a document rendered in the
 *  first visitor's language and every later visitor gets it as a hit. Public,
 *  unauthenticated pages served in the wrong language, silently, for the length
 *  of the TTL.
 *
 *  So a failed read now returns `null` — "cannot determine" — and the caller
 *  declines to cache rather than segmenting on a fabricated key. Availability is
 *  unchanged: the page still renders, correctly, just uncached while degraded.
 *
 *  `null` covers TWO cases that are not the same fact, and this is deliberate:
 *  the settings read failed (genuinely unknown), or there is no such org
 *  (definitively knowable — `resolvePublicOrg` throws `not_found`). They are
 *  merged because the ONLY consumer uses the value as a cache key, and neither
 *  case yields an honest one: an unknown org renders `null` downstream and 404s,
 *  so nothing was ever cached for it either way. If a second consumer appears
 *  that needs to TELL these apart, split them then — do not let this comment
 *  become the reason a caller assumes they are distinguishable. */
export async function negotiatePublicLocale(orgId: string, acceptLanguage?: string | null): Promise<string | null> {
  try {
    const tenantId = await resolvePublicOrg(orgId);
    const settings = await getContentLanguageSettings(tenantId, orgId);
    const supported = [settings.baseLocale, ...settings.supportedLocales].filter(Boolean);
    return supported.length > 1 ? negotiateLocale(acceptLanguage, supported, settings.baseLocale) : settings.baseLocale;
  } catch (err) {
    log.warn('public_locale_negotiation_failed', { orgId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Published pages for an org's public surface (sitemap/feed/blog), excluding
 *  `noindex` pages from indexable outputs (the caller filters per output). Reads
 *  the org's SEO rows in ONE store scan + a map, NOT a get() per page — this is
 *  a public, unauthenticated path that must not fan out N storage reads/request.
 *  `filter` NARROWS the set (e.g. `kind:'post'` for the blog) — it is applied by
 *  `listPages` (the IDOR-safe narrow-never-widen contract). Returns the resolved
 *  tenant so an enriched caller (the blog feed) can resolve author names. */
interface PublishedWithSeo { tenantId: string; rows: Array<{ page: Page; seo: PageSeo | null }> }

// SEO-2 / BLOG-1 — per (orgId, filter-kind) TTL memo over the global page scan +
// SEO scan (documented in publicReadCache.ts: TTL-only invalidation, LRU-bounded,
// TTL=0 disables). Downstream callers filter/sort into NEW arrays and never
// mutate the cached rows, so sharing the reference is safe.
const publishedListCache = new TtlLruCache<PublishedWithSeo>(publicListTtlMs, 500);
/** Stable key over the NARROWING filter fields (bounded values — the route caps
 *  each query param at 120 chars). `status` is always `published` here. The
 *  separator is a NUL (written as the backslash-u escape, never a raw NUL byte
 *  per the source-hygiene gate): it can't occur in any bounded field value, so
 *  it disambiguates a tag containing a space from an adjacent field. */
function listCacheKey(orgId: string, filter?: PageListFilter): string {
  const f = filter ?? {};
  return [orgId, f.kind ?? '', f.tag ?? '', f.category ?? '', f.authorId ?? '', f.q ?? '', f.collection ?? ''].join('\u0000');
}

async function listPublishedWithSeo(orgId: string, filter?: PageListFilter): Promise<PublishedWithSeo> {
  const cacheKey = listCacheKey(orgId, filter);
  const cached = publishedListCache.get(cacheKey);
  if (cached) return cached;
  const tenantId = await resolvePublicOrg(orgId);
  // ADR 0392 — docs-collection pages are public but are NOT marketing pages:
  // they are excluded from the marketing sitemap/RSS (and marketing nav) and
  // enumerated by the docs feature's own nav tree instead. This is the single
  // choke point for sitemap.xml, feed.rss, AND the blog surface (ADR 0391's
  // `filter` narrows further, e.g. kind:'post').
  const published = (await listPages(tenantId, orgId, { ...filter, status: 'published' }))
    .filter((p) => p.collection !== 'docs');
  const seoByPage = new Map<string, PageSeo>();
  for (const s of await seoStore.list()) {
    if (s.tenantId === tenantId && s.orgId === orgId) seoByPage.set(s.pageId, s);
  }
  const result: PublishedWithSeo = { tenantId, rows: published.map((page) => ({ page, seo: seoByPage.get(page.pageId) ?? null })) };
  publishedListCache.set(cacheKey, result);
  return result;
}

/** Test-only: drop the published-list memo so a freshly-seeded page is visible. */
export function __resetPublicReadCaches(): void {
  publishedListCache.clear();
}

/** Resolve each post's byline principal (its `authorId`, else `createdBy`) to a
 *  display name via the ONE subject-display seam (ADR 0192 D2) — never a second
 *  name store. Keyed by `pageId`; an unresolvable principal degrades inside the
 *  seam to a humanized id, never a raw ref. */
async function resolveAuthorNames(tenantId: string, posts: readonly Page[]): Promise<Map<string, { id: string; name: string }>> {
  const refs = posts.map((p) => userRef(p.authorId ?? p.createdBy));
  const displays = await resolveSubjectDisplays(tenantId, refs);
  const out = new Map<string, { id: string; name: string }>();
  posts.forEach((p, i) => {
    const id = p.authorId ?? p.createdBy;
    // ADR 0593 §C9 (review F5) — NEVER `?? id`. The seam's contract is "absent
    // resolvers degrade to fallbacks — never a raw ref"; a caller-side fallback
    // to the principal silently revokes that on the one surface where it is
    // read by anyone on the internet. If the seam somehow returns nothing, emit
    // no byline at all rather than an identifier.
    const name = displays.get(refs[i]!)?.displayName;
    out.set(p.pageId, { id, ...(name ? { name } : { name: '' }) });
  });
  return out;
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
    (await listPublishedWithSeo(orgId)).rows.filter(({ seo }) => !seo?.noindex).sort((a, b) => (a.page.slug < b.page.slug ? -1 : 1)),
    orgId, 'sitemap',
  );
  const urls = rows
    .map(({ page }) => `  <url>\n    <loc>${escapeXml(pageUrl(baseUrl, orgId, page.slug))}</loc>\n    <lastmod>${escapeXml(page.updatedAt)}</lastmod>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** ADR 0486 — the public-site NAV list: published marketing pages (slug + title)
 *  for the public shell's menu, so EVERY published page is reachable from the
 *  home page without a stale hard-coded list. Rides the SAME published-only +
 *  toggle-gated choke as the sitemap (`listPublishedWithSeo` already drops docs
 *  pages). Excludes the `home` page (it is the brand link) and blog posts
 *  (`kind:'post'` — they live under the /blog surface) and `noindex` pages (an
 *  author who kept a page out of the sitemap MUST NOT find it promoted into the
 *  PRIMARY visible menu — the same `!seo?.noindex` exclusion sitemap.xml applies).
 *  Sorted by title; bounded by `capPublic`. Draft/unpublished pages never appear
 *  (no dishonest 404 link). */
export async function listPublicNavPages(orgId: string): Promise<Array<{ slug: string; title: string }>> {
  const { rows } = await listPublishedWithSeo(orgId);
  return capPublic(
    rows
      .filter(({ page, seo }) => page.slug !== 'home' && page.kind !== 'post' && !seo?.noindex)
      .sort((a, b) => (a.page.title.toLowerCase() < b.page.title.toLowerCase() ? -1 : 1)),
    orgId, 'nav',
  ).map(({ page }) => ({ slug: page.slug, title: page.title }));
}

export async function robotsTxt(orgId: string, baseUrl: string): Promise<string> {
  // Touch the toggle gate so robots.txt for a publishing-off org 404s too.
  await resolvePublicOrg(orgId);
  const sitemap = `${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(orgId)}/sitemap.xml`;
  // R2-D11 — advertise the docs' llms.txt to the agents that read robots first.
  // A comment line (llms.txt has no robots directive); the real door is the
  // root path the hosting rewrite serves.
  const llms = `${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(orgId)}/llms.txt`;
  return `User-agent: *\nAllow: /\nSitemap: ${sitemap}\n# llms.txt: ${llms}\n`;
}

/** The generic published-pages RSS feed (ADR 0012). */
export async function feedRss(orgId: string, baseUrl: string): Promise<string> {
  return buildFeed(orgId, baseUrl, { selfSuffix: '/feed.rss', channelTitle: orgId, channelDescription: 'Published pages', surface: 'feed', enriched: false });
}

/** ADR 0391 (a) — the BLOG-scoped, author-enriched RSS feed: the SAME generator
 *  as `feedRss` narrowed to `kind:'post'`, declaring `xmlns:dc` and emitting
 *  `<dc:creator>` (author display name) + a `<category>` per tag and the primary
 *  category. Content-type `application/rss+xml`; NOT a second RSS path. */
export async function blogFeedXml(orgId: string, baseUrl: string): Promise<string> {
  return buildFeed(orgId, baseUrl, { selfSuffix: '/blog/feed.xml', channelTitle: `${orgId} blog`, channelDescription: 'Published blog posts', surface: 'blog-feed', enriched: true, filter: { kind: 'post' } });
}

interface FeedOptions {
  selfSuffix: string;
  channelTitle: string;
  channelDescription: string;
  surface: string;
  /** Enriched = declare `xmlns:dc` + emit `<dc:creator>`/`<category>` per item. */
  enriched: boolean;
  filter?: PageListFilter;
}

/** The ONE RSS generator (ADR 0012 + 0391): newest-first published items sharing
 *  `capPublic`/`escapeXml`/`pageUrl`/`descriptionFrom`. `enriched` adds the blog
 *  Dublin-Core author + category elements; the non-enriched path is byte-identical
 *  to the original `feedRss` (pinned by publishing-route.test.ts). */
async function buildFeed(orgId: string, baseUrl: string, opts: FeedOptions): Promise<string> {
  const { tenantId, rows: all } = await listPublishedWithSeo(orgId, opts.filter);
  // The enriched (blog) feed orders + dates by the PUBLISH instant so editing a
  // published post doesn't re-float it or reset its <pubDate> (ADR 0391 a).
  // The generic feed stays on `updatedAt` — byte-identical to the original
  // `feedRss` (pinned by publishing-route.test.ts).
  const feedTs = (page: Page): string => (opts.enriched ? page.publishedAt ?? page.updatedAt : page.updatedAt);
  const rows = capPublic(
    all.filter(({ seo }) => !seo?.noindex).sort((a, b) => (feedTs(a.page) < feedTs(b.page) ? 1 : -1)),
    orgId, opts.surface,
  );
  const authors = opts.enriched ? await resolveAuthorNames(tenantId, rows.map((r) => r.page)) : undefined;
  const items = rows
    .map(({ page, seo }) => {
      const link = pageUrl(baseUrl, orgId, page.slug);
      const title = seo?.metaTitle ?? page.title;
      const desc = seo?.metaDescription ?? descriptionFrom(page);
      let extra = '';
      if (opts.enriched) {
        const creator = authors?.get(page.pageId);
        if (creator) extra += `\n      <dc:creator>${escapeXml(creator.name)}</dc:creator>`;
        for (const cat of [page.category, ...(page.tags ?? [])].filter((c): c is string => !!c)) {
          extra += `\n      <category>${escapeXml(cat)}</category>`;
        }
      }
      return `    <item>\n      <title>${escapeXml(title)}</title>\n      <link>${escapeXml(link)}</link>\n      <guid isPermaLink="true">${escapeXml(link)}</guid>\n      <pubDate>${escapeXml(new Date(feedTs(page)).toUTCString())}</pubDate>\n      <description>${escapeXml(desc)}</description>${extra}\n    </item>`;
    })
    .join('\n');
  const self = `${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(orgId)}${opts.selfSuffix}`;
  const rssOpen = opts.enriched
    ? '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">'
    : '<rss version="2.0">';
  return `<?xml version="1.0" encoding="UTF-8"?>\n${rssOpen}\n  <channel>\n    <title>${escapeXml(opts.channelTitle)}</title>\n    <link>${escapeXml(`${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(orgId)}`)}</link>\n    <description>${escapeXml(opts.channelDescription)}</description>\n    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(self)}" rel="self" type="application/rss+xml" />\n${items}\n  </channel>\n</rss>\n`;
}

// ─── ADR 0391 (a) — the public blog list read ────────────────────────────────

export interface PublicBlogPost {
  pageId: string;
  slug: string;
  title: string;
  authorId: string;
  authorName?: string;
  category?: string;
  tags: string[];
  excerpt: string;
  publishedAt: string;
  /** Whole minutes to read the published body, floored at 1 (see {@link readingMinutesFor}). */
  readingMinutes: number;
  /** The post's OG image token, reused as the index card's cover. Present only
   *  when the author set one — never synthesized. */
  coverImageToken?: string;
}

/** Section-data keys that carry human PROSE. An allowlist (not a deep walk of
 *  every string) so URLs, asset tokens, icon slugs, layout names and entity/type
 *  ids never inflate a reading estimate. Mirrors the text the public
 *  `SectionRenderer` actually draws. */
const PROSE_KEYS = new Set([
  'heading', 'subheading', 'eyebrow', 'text', 'lede', 'blurb', 'caption',
  'title', 'label', 'alt', 'ctaLabel', 'ctaLabel2',
]);

/** Stop counting past this many words (~2h of reading). The blog list is an
 *  UNAUTHENTICATED read over up to `MAX.publicListUrls` posts, so per-post work
 *  must be bounded — and a reading estimate is meaningless at that length
 *  anyway. Reaching the cap yields `≥ WORD_CAP/225` minutes, never a wrong
 *  *small* number. */
const READING_WORD_CAP = 30_000;
const READING_WPM = 225;

/** Accumulate prose words in one section-data value (recursing into `columns[]`
 *  etc.), short-circuiting once the budget is spent. Returns the running total. */
function proseWords(value: unknown, acc: number): number {
  if (acc >= READING_WORD_CAP) return acc;
  if (Array.isArray(value)) {
    let n = acc;
    for (const v of value) { n = proseWords(v, n); if (n >= READING_WORD_CAP) break; }
    return n;
  }
  if (value === null || typeof value !== 'object') return acc;
  let n = acc;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') { if (PROSE_KEYS.has(k)) n += v.trim().split(/\s+/).filter(Boolean).length; }
    else n = proseWords(v, n);
    if (n >= READING_WORD_CAP) break;
  }
  return n;
}

/** Whole minutes to read a page's published body at 225 wpm (the widely used
 *  adult silent-reading rate), floored at 1 so a short post never reads "0 min"
 *  and capped by {@link READING_WORD_CAP} so one enormous page can't make an
 *  unauthenticated list read expensive. Computed from the SAME sections the
 *  public renderer draws, so the estimate can't drift from what a visitor
 *  actually sees. Deterministic — no clock, no random. */
export function readingMinutesFor(page: Pick<Page, 'sections'>): number {
  let words = 0;
  for (const s of page.sections) {
    words = proseWords(s.data, words);
    if (words >= READING_WORD_CAP) break;
  }
  return Math.max(1, Math.round(words / READING_WPM));
}

/** Published blog posts (`kind:'post'`) for an org's public surface, newest-first
 *  by the PUBLISH instant (`publishedAt ?? updatedAt` — legacy rows fall back), so
 *  editing a published post never re-floats it. `filter` narrows by tag / category
 *  / author (the IDOR-safe narrow-never-widen `listPages` contract). A projection
 *  only — NEVER draft section bodies. Excerpt via the shared `descriptionFrom`;
 *  author via the ONE subject-display seam. `capPublic`-bounded. */
/**
 * ADR 0668 D3 (CMSLWF-14) — returns the NEGOTIATED LOCALE alongside the posts.
 *
 * This route localizes `excerpt` and `readingMinutes` per post, and set neither `Vary`
 * nor `Content-Language` — alone among its siblings in `routes.ts`, every one of which
 * sets both. The locale forwarding was added without the headers (see the R2-BLOG-3 note
 * below), so the response varied on a header it never declared.
 *
 * The route cannot honestly echo the REQUEST's `Accept-Language` back as
 * `Content-Language`; it must state the locale actually used. On the `localizable ===
 * false` short-circuit no negotiation runs at all, so the truthful answer there is the
 * org's base locale, computed rather than guessed.
 */
export async function listPublicBlog(orgId: string, filter?: { tag?: string; category?: string; author?: string }, acceptLanguage?: string | null): Promise<{ posts: PublicBlogPost[]; locale: string }> {
  const listFilter: PageListFilter = {
    kind: 'post',
    ...(filter?.tag ? { tag: filter.tag } : {}),
    ...(filter?.category ? { category: filter.category } : {}),
    ...(filter?.author ? { authorId: filter.author } : {}),
  };
  const { tenantId, rows } = await listPublishedWithSeo(orgId, listFilter);
  const postDate = (p: Page): string => p.publishedAt ?? p.updatedAt;
  // Keep the {page, seo} pair — the card cover reuses the post's OG image token,
  // which lives on the SEO row, not the page.
  const paired = capPublic(
    [...rows].sort((a, b) => (postDate(a.page) < postDate(b.page) ? 1 : -1)),
    orgId, 'blog',
  );
  const authors = await resolveAuthorNames(tenantId, paired.map(({ page }) => page));
  // R2-BLOG-3 — the excerpt (and the reading estimate derived from the same
  // sections) honors Accept-Language through the SAME RFC 0103 negotiation the
  // page view uses, so a localized site's cards match the localized body a
  // click away. Note `title` stays base — `localizePage` never localizes the
  // title field, on the page view either, so cards and pages stay consistent.
  // Projection cost only: the row cache above is locale-independent.
  const settings = await getContentLanguageSettings(tenantId, orgId);
  const localizable = settings.supportedLocales.length > 0;
  let negotiated = settings.baseLocale;
  const posts = paired.map(({ page, seo }) => {
    const author = authors.get(page.pageId);
    // No authored locales (the common case) ⇒ resolution is the identity; skip
    // the per-post section rebuild on this unauthenticated hot path.
    let localized = page;
    if (localizable) {
      const r = localizePage(page, acceptLanguage ?? undefined, settings);
      localized = r.page as Page;
      negotiated = r.locale;
    }
    return {
      pageId: page.pageId,
      slug: page.slug,
      title: page.title,
      authorId: author?.id ?? page.createdBy,
      ...(author?.name ? { authorName: author.name } : {}),
      ...(page.category ? { category: page.category } : {}),
      tags: page.tags ?? [],
      excerpt: descriptionFrom(localized),
      publishedAt: postDate(page),
      readingMinutes: readingMinutesFor(localized),
      ...(seo?.ogImageToken ? { coverImageToken: seo.ogImageToken } : {}),
    };
  });
  return { posts, locale: negotiated };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function projectPublic(
  page: Page,
  seo: PageSeo | null,
  orgId: string,
  baseUrl: string,
  redirectedFrom?: string,
  experiment?: { experimentId: string; variant: string },
): PublicPage {
  const description = seo?.metaDescription ?? descriptionFrom(page);
  const out: PublicPage = {
    slug: page.slug,
    title: page.title,
    sections: page.sections,
    ...(page.publishedVersion !== undefined ? { publishedVersion: page.publishedVersion } : {}),
    updatedAt: page.updatedAt,
    ...(redirectedFrom ? { redirectedFrom } : {}),
    ...(experiment ? { experiment } : {}),
    seo: {
      title: seo?.metaTitle ?? page.title,
      description,
      canonicalUrl: seo?.canonicalUrl ?? pageUrl(baseUrl, orgId, page.slug),
      ogTitle: seo?.ogTitle ?? seo?.metaTitle ?? page.title,
      ogDescription: seo?.ogDescription ?? description,
      noindex: seo?.noindex ?? false,
      ...(seo?.ogImageToken ? { ogImageUrl: `${vendorPublicBase(baseUrl)}/assets/${encodeURIComponent(seo.ogImageToken)}` } : {}),
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
  return `${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`;
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
