/**
 * Crawler prerender (ADR 0384 Phases 2–4) — composes the EXISTING public
 * projection (`publicPageBySlug` — published-only, org→tenant, locale
 * negotiation, redirect-follow) into a full HTML document for crawlers:
 * inline `<head>` (title/description/robots/OG/Twitter/canonical), semantic
 * body from `sectionHtml`, JSON-LD (Phase 3), hreflang (Phase 4).
 *
 * Invariants (test-enforced):
 *   - NO re-derivation: every head value comes from the projection's `seo`
 *     block or the localized page — the bot head equals the SPA's eventual
 *     head field-for-field, and matches sitemap.xml/feed.rss (same SSoT).
 *   - NO cloaking: bot and human resolve the SAME page through the SAME
 *     `publicPageBySlug` call; only the markup differs. Bots send no `vk`, so
 *     they get the plain published page (exactly what a consentless human
 *     gets — ADR 0236 assignment requires an explicit visitor key).
 *   - Honest-off: an unrenderable section (unknown future type) returns null
 *     and the caller serves the SPA shell — never a partial document.
 */
import type { Section } from '../cms/cmsService.js';
// ADR 0406 Phase 1 — settings are core-owned now; importing the core module
// directly removes the publishing→cms feature edge this line used to carry.
import { getContentLanguageSettings } from '../../host/contentLocales.js';
import { getOrg } from '../../host/accessControlService.js';
import { publicPageBySlug, negotiatePublicLocale, listPublicBlog } from './publishingService.js';
import { escapeHtml, pageBodyHtml } from './sectionHtml.js';
import { resolveContentSection, isEssentialSectionType, type ResolvedContentSection } from '../../host/contentDataSources.js';
import { TtlLruCache } from './publicReadCache.js';
import { vendorPublicBase } from '../featureRoute.js';

// ─── bot detection (UA allowlist, env-extensible) ────────────────────────────

/** Social unfurlers + AI crawlers (superset of the MyndHyve list). */
const BOT_UA_TOKENS = [
  // social unfurlers
  'facebookexternalhit', 'facebot', 'twitterbot', 'linkedinbot', 'slackbot',
  'discordbot', 'whatsapp', 'telegrambot', 'pinterest', 'redditbot', 'applebot',
  // search engines (document parity with the sitemap they crawl)
  'googlebot', 'bingbot', 'duckduckbot', 'yandexbot', 'baiduspider',
  // AI crawlers
  'gptbot', 'chatgpt-user', 'oai-searchbot', 'claudebot', 'claude-user',
  'anthropic-ai', 'perplexitybot', 'perplexity-user', 'google-extended',
  'applebot-extended', 'ccbot', 'bytespider', 'amazonbot', 'meta-externalagent',
  'cohere-ai', 'diffbot', 'youbot',
];

function extraBotTokens(): string[] {
  return (process.env.OPENWOP_SEO_BOT_UA_EXTRA ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Case-insensitive substring match against the allowlist. */
export function isBotUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return [...BOT_UA_TOKENS, ...extraBotTokens()].some((t) => ua.includes(t));
}

/** Operator kill-switch (env, NOT a tenant toggle — ADR 0384 "why no toggle"). */
export function prerenderDisabled(): boolean {
  return process.env.OPENWOP_SEO_PRERENDER_DISABLED === 'true';
}

/** Prerender cache TTL seconds (published-gated, low-churn content). */
export function prerenderTtlSeconds(): number {
  const raw = Number(process.env.OPENWOP_SEO_PRERENDER_TTL_S);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3600;
}

// ─── document assembly ───────────────────────────────────────────────────────

export interface HeadInput {
  seo: {
    title: string;
    description: string;
    canonicalUrl: string;
    ogTitle: string;
    ogDescription: string;
    ogImageUrl?: string;
    noindex: boolean;
  };
  /** PUB2-B2 — OPTIONAL. `locale` reaches `<html lang>` and `og:locale`, both of
   *  which are claims: `lang` selects a screen reader's pronunciation rules and
   *  a search engine's language targeting. When the negotiation could not be
   *  made there is no honest value, and a guess is worse than an omission — an
   *  absent `lang` means "unspecified", while `lang="en"` over Portuguese is
   *  wrong. Absent here ⇒ both are omitted, not defaulted. */
  locale?: string;
  /** Site display name for og:site_name / JSON-LD (org name — never invented). */
  siteName?: string;
  /** hreflang alternates (Phase 4): locale → absolute URL. */
  alternates?: Record<string, string>;
  /** JSON-LD blocks (Phase 3), already-serializable objects. */
  jsonLd?: object[];
}

function metaTags(h: HeadInput): string {
  const s = h.seo;
  const tags: string[] = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(s.title)}</title>`,
    `<meta name="description" content="${escapeHtml(s.description)}">`,
    `<meta name="robots" content="${s.noindex ? 'noindex, nofollow' : 'index, follow'}">`,
    `<link rel="canonical" href="${escapeHtml(s.canonicalUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(s.ogTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(s.ogDescription)}">`,
    `<meta property="og:url" content="${escapeHtml(s.canonicalUrl)}">`,
  ];
  if (h.locale) tags.push(`<meta property="og:locale" content="${escapeHtml(h.locale)}">`);
  if (h.siteName) tags.push(`<meta property="og:site_name" content="${escapeHtml(h.siteName)}">`);
  if (s.ogImageUrl) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(s.ogImageUrl)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:image" content="${escapeHtml(s.ogImageUrl)}">`,
    );
  } else {
    tags.push(`<meta name="twitter:card" content="summary">`);
  }
  tags.push(
    `<meta name="twitter:title" content="${escapeHtml(s.ogTitle)}">`,
    `<meta name="twitter:description" content="${escapeHtml(s.ogDescription)}">`,
  );
  for (const [loc, url] of Object.entries(h.alternates ?? {})) {
    tags.push(`<link rel="alternate" hreflang="${escapeHtml(loc)}" href="${escapeHtml(url)}">`);
  }
  for (const block of h.jsonLd ?? []) {
    // `<` escaped inside JSON so `</script>` can never break out of the block.
    tags.push(`<script type="application/ld+json">${JSON.stringify(block).replace(/</g, '\\u003c')}</script>`);
  }
  return tags.join('\n');
}

export function buildHtmlDocument(head: HeadInput, bodyInner: string): string {
  return `<!doctype html>
<html${head.locale ? ` lang="${escapeHtml(head.locale)}"` : ''}>
<head>
${metaTags(head)}
</head>
<body>
${bodyInner}
</body>
</html>
`;
}

// ─── JSON-LD (Phase 3 — emitted from the projection + org, honestly scoped) ──

interface JsonLdInput {
  seo: HeadInput['seo'];
  page: { title: string; updatedAt: string; slug: string; sections: Section[] };
  locale: string;
  siteName?: string;
  baseUrl: string;
}

/** Organization + WebSite + WebPage/Article + BreadcrumbList — plus FAQPage
 *  when the page holds typed `faq` sections. (ADR 0384 deferred FAQPage
 *  "until a typed `faq` section exists"; R2-G10 shipped that type, so the
 *  block is now emitted from the SAME validated section data — never
 *  fabricated from non-FAQ sections.) */
export function jsonLdBlocks(input: JsonLdInput): object[] {
  const { seo, page, locale, siteName, baseUrl } = input;
  const blocks: object[] = [];
  const faqItems = page.sections.filter((s) => s.type === 'faq').flatMap((s) => {
    const items = (s.data as { items?: unknown }).items;
    return Array.isArray(items)
      ? items.filter((it): it is { q: string; a: string } => {
        const ii = it as { q?: unknown; a?: unknown };
        return typeof ii.q === 'string' && ii.q.length > 0 && typeof ii.a === 'string' && ii.a.length > 0;
      })
      : [];
  });
  if (faqItems.length > 0) {
    blocks.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqItems.map((it) => ({
        '@type': 'Question',
        name: it.q,
        acceptedAnswer: { '@type': 'Answer', text: it.a },
      })),
    });
  }
  if (siteName) {
    blocks.push({ '@context': 'https://schema.org', '@type': 'Organization', name: siteName, url: baseUrl });
    blocks.push({ '@context': 'https://schema.org', '@type': 'WebSite', name: siteName, url: baseUrl });
  }
  // Article when the page carries article semantics (hero + richText body).
  const isArticle = page.sections.some((s) => s.type === 'hero') && page.sections.some((s) => s.type === 'richText');
  blocks.push({
    '@context': 'https://schema.org',
    '@type': isArticle ? 'Article' : 'WebPage',
    headline: seo.title,
    description: seo.description,
    dateModified: page.updatedAt,
    inLanguage: locale,
    url: seo.canonicalUrl,
    ...(seo.ogImageUrl ? { image: seo.ogImageUrl } : {}),
  });
  blocks.push({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: siteName ?? 'Home', item: baseUrl },
      { '@type': 'ListItem', position: 2, name: page.title, item: seo.canonicalUrl },
    ],
  });
  return blocks;
}

// ─── the composed prerender ──────────────────────────────────────────────────

export interface PrerenderResult {
  html: string;
  locale: string;
  noindex: boolean;
}

/**
 * Prerender one published page, or null when the body is unrenderable (the
 * caller serves the SPA shell). Throws the projection's own errors (404 for
 * unknown org/slug — the uniform-404 posture is inherited, not re-implemented).
 */
export async function prerenderPage(
  orgId: string,
  slug: string,
  baseUrl: string,
  acceptLanguage: string | null | undefined,
  siteName?: string,
): Promise<PrerenderResult | null> {
  const { page, locale } = await publicPageBySlug(orgId, slug, baseUrl, acceptLanguage ?? null, null);

  // og:site_name / JSON-LD Organization from the org record — never invented.
  // An operator-provided site name (env) overrides; absence omits the fields.
  // Resolved BEFORE the body so the tenant is available for entity resolution.
  let resolvedSiteName = siteName;
  let tenantId: string | undefined;
  try {
    const org = await getOrg(orgId);
    if (org) {
      tenantId = org.tenantId;
      if (!resolvedSiteName && typeof org.name === 'string' && org.name.trim()) resolvedSiteName = org.name.trim();
    }
  } catch {
    // Org metadata is an enhancement here — publicPageBySlug already 404'd unknown orgs.
  }

  // ADR 0407 D3 — resolve referenced entity sections SERVER-SIDE for crawlers
  // via the core content-section registry (published + public + live rows only
  // — the same gate humans hit, so no cloaking). Bounded (≤ the section's limit,
  // rare per page); a resolver failure degrades to the section's chrome.
  const resolvedSections: Record<string, ResolvedContentSection> = {};
  for (const s of page.sections) {
    // ADR 0641 decision 8 — an ESSENTIAL section type is resolved here too, and
    // `resolveContentSection` THROWS for it rather than returning null. That
    // exception is deliberately NOT caught: letting it propagate is what fails
    // the prerender for this page instead of emitting intact chrome around
    // nothing. Catching it here would rebuild the degradation the flag exists
    // to prevent, one layer down.
    if (s.type !== 'entityList' && s.type !== 'entityDetail' && !isEssentialSectionType(s.type)) continue;
    const r = await resolveContentSection(s.type, s.data as Record<string, unknown>, {
      ...(tenantId ? { pageTenantId: tenantId } : {}),
      locale,
    });
    if (r && r.items.length > 0) resolvedSections[s.sectionId] = r;
  }

  const body = pageBodyHtml(page.sections, {
    assetBase: baseUrl,
    ...(Object.keys(resolvedSections).length > 0 ? { resolvedSections } : {}),
  });
  if (body === null) return null; // unknown section type → SPA fallback

  // hreflang alternates from the org's authored locales (ADR 0064). The
  // negotiation is Accept-Language-driven (no per-locale URLs), so alternates
  // point at the same canonical with x-default — emitted only when the org
  // authors more than the base locale.
  let alternates: Record<string, string> | undefined;
  try {
    if (tenantId) {
      const langs = await getContentLanguageSettings(tenantId, orgId);
      const all = [langs.baseLocale, ...langs.supportedLocales].filter(Boolean);
      if (all.length > 1) {
        alternates = Object.fromEntries([...all.map((l) => [l, page.seo.canonicalUrl] as const), ['x-default', page.seo.canonicalUrl] as const]);
      }
    }
  } catch {
    // Language settings are an enhancement — a read failure never blocks the render.
  }

  const html = buildHtmlDocument(
    {
      seo: page.seo,
      locale,
      ...(resolvedSiteName !== undefined ? { siteName: resolvedSiteName } : {}),
      ...(alternates !== undefined ? { alternates } : {}),
      jsonLd: [
        ...jsonLdBlocks({ seo: page.seo, page, locale, ...(resolvedSiteName !== undefined ? { siteName: resolvedSiteName } : {}), baseUrl }),
        // ADR 0407 D3 — an ItemList per resolved entityList/entityDetail (the
        // SEO-valuable structured data for entity collections). Honest: only
        // resolved (public, live) items appear.
        // ADR 0653 phase C — `url` on a ListItem when the resolver supplied an
        // `href`, ABSENT otherwise.
        //
        // `ResolvedContentItem.href` has been declared since ADR 0407 and read
        // by nobody: this emitter built `{name}` with no `url`, and the only
        // `.href` reader in the tree is a `columns` card's OWN href in
        // `sectionHtml.ts`, which is a different field entirely. So the producer
        // side and the consumer side were both dead, and closing either alone
        // would have been useless — found by the peer session while scoping the
        // entityDetail slug-binding deferral.
        //
        // Conditional rather than always-present, and that is the load-bearing
        // part. schema.org `url` on a ListItem is a CLAIM that the item has a
        // followable page. Entities have no public page routes yet — the
        // deferral ADR 0407 records "with cause" — so emitting a guessed URL
        // would put a 404 in structured data a crawler trusts. An absent field
        // is a smaller, honest gap; a present-and-wrong one is the quiet lie
        // this codebase keeps choosing against.
        ...Object.values(resolvedSections).map((r) => ({
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          itemListElement: r.items.map((it, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: it.title,
            ...(it.href === undefined || it.href === '' ? {} : { url: it.href }),
          })),
        })),
      ],
    },
    body,
  );
  return { html, locale, noindex: page.seo.noindex };
}

// ─── prerender HTML memo (SEO-2) ──────────────────────────────────────────────

// Per `(orgId, slug, negotiated-locale)` TTL memo over the full projection +
// render (TTL = the prerender TTL; TTL-only invalidation, matching ADR 0384's
// cache posture — a just-published edit is visible within the TTL). The
// `Vary: User-Agent` on the platform-origin door otherwise fragments the CDN
// per-UA, so `max-age` is effectively uncached; this memo restores hit-rate at
// the origin. Bounded LRU so a hostile client varying Accept-Language cannot
// grow the map without bound. `baseUrl`/`siteName` are stable per deployment, so
// they are NOT in the key (they're bound at render time). Nulls (SPA-shell
// fallback) are not cached — rare and cheap.
const prerenderHtmlCache = new TtlLruCache<PrerenderResult>(() => prerenderTtlSeconds() * 1000, 500);

/**
 * `prerenderPage` behind the HTML memo. The route uses THIS; the raw
 * `prerenderPage` stays exported for tests/callers that need an uncached render.
 */
export async function prerenderPageCached(
  orgId: string,
  slug: string,
  baseUrl: string,
  acceptLanguage: string | null | undefined,
  siteName?: string,
): Promise<PrerenderResult | null> {
  const locale = await negotiatePublicLocale(orgId, acceptLanguage);
  if (locale === null) {
    // PUB2-B1 — the negotiation failed, so there is no honest key to file this
    // document under. Caching it anyway is what served one visitor's language to
    // the next: every failing request collapsed to the same fabricated `'en'`
    // key, and the first render (correct for ITS visitor) became everyone's hit.
    // Render fresh and store nothing — degraded hit-rate, never wrong content.
    return prerenderPage(orgId, slug, baseUrl, acceptLanguage, siteName);
  }
  const key = `${orgId}\n${slug}\n${locale}`;
  const hit = prerenderHtmlCache.get(key);
  if (hit) return hit;
  const out = await prerenderPage(orgId, slug, baseUrl, acceptLanguage, siteName);
  if (out) prerenderHtmlCache.set(key, out);
  return out;
}

// ─── blog-index prerender (ADR 0391 — custom-domain `/blog`) ──────────────────

/**
 * A semantic crawler document for the blog INDEX (title / date / byline /
 * excerpt links) over the `listPublicBlog` projection. Post links are relative
 * (`/blog/:slug`) so they resolve on the bound custom host (customDomain.ts maps
 * `/blog/:slug` → the page prerender) AND on the platform origin. Honest head:
 * no fabricated fields; unknown org 404s inside `listPublicBlog`.
 */
export async function prerenderBlogIndex(
  orgId: string,
  baseUrl: string,
  siteName?: string,
  acceptLanguage?: string | null,
): Promise<string> {
  // ADR 0668 D3 (CMSLWF-20) — the reader's locale was dropped HERE. This function
  // negotiates a locale for `<html lang>` (below) but called `listPublicBlog` with no
  // `acceptLanguage`, so every excerpt and reading estimate stayed base-language while the
  // document declared `lang="es"` — the head and the body disagreeing about the same page,
  // which is the family this ADR exists to close. PUB2-B2's "it negotiates like every other
  // prerendered document now" was true of the ATTRIBUTE and false of the CONTENT.
  //
  // The two negotiations stay separate on purpose: `negotiatePublicLocale` returns `null`
  // on a failed settings read so the attribute is OMITTED rather than guessed (PUB2-B1),
  // whereas the content path falls back to the org's base locale. Same input, deliberately
  // different failure semantics.
  const { posts } = await listPublicBlog(orgId, undefined, acceptLanguage ?? null);
  const heading = siteName ? `${siteName} — Blog` : 'Blog';
  const items = posts.map((p) => {
    const byline = p.authorName ? `<span>${escapeHtml(p.authorName)}</span>` : '';
    return `<li><article>`
      + `<h2><a href="/blog/${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a></h2>`
      + `<p><time datetime="${escapeHtml(p.publishedAt)}">${escapeHtml(p.publishedAt)}</time>${byline ? ` · ${byline}` : ''}</p>`
      + (p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : '')
      + `</article></li>`;
  }).join('\n');
  const body = `<main>
<header><h1>${escapeHtml(heading)}</h1></header>
<ul>
${items}
</ul>
</main>`;
  const canonical = `${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(orgId)}/blog`;
  const locale = await negotiatePublicLocale(orgId, acceptLanguage);
  const head: HeadInput = {
    seo: {
      title: heading,
      description: heading,
      canonicalUrl: canonical,
      ogTitle: heading,
      ogDescription: heading,
      noindex: false,
    },
    // PUB2-B2 — this was hardcoded `'en'` directly beneath a docstring promising
    // "Honest head: no fabricated fields". `locale` reaches `<html lang>`, which
    // is what a screen reader uses to choose pronunciation and what search
    // engines use for language targeting, so on a pt-BR or fr-FR site it was a
    // false declaration over the site's own posts. It negotiates like every
    // other prerendered document now; when the negotiation cannot be made, the
    // attribute is omitted rather than guessed (`buildHtmlDocument` emits a bare
    // `<html>`), because no claim is better than a wrong one.
    ...(locale !== null ? { locale } : {}),
    ...(siteName ? { siteName } : {}),
  };
  return buildHtmlDocument(head, body);
}
