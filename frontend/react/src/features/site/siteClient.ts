/**
 * Public front-page client (ADR 0027). Reads the designated site-org's PUBLISHED
 * home page through the EXISTING unauthenticated Publishing API (ADR 0012):
 *   GET /host/openwop-app/public/:orgId/pages/:slug
 * No auth headers, no credentials — the surface is public by definition
 * (published-only; drafts/archived 404). The shape mirrors the backend
 * `PublicPage` projection (sections + merged SEO).
 */
import { config } from '../../client/config.js';
import { getRequestLocale } from '../../i18n/requestLocale.js';
import type { Section } from '../cms/cmsClient.js';

export interface PublicPageSeo {
  title: string;
  description: string;
  canonicalUrl: string;
  ogTitle: string;
  ogDescription: string;
  ogImageUrl?: string;
  noindex: boolean;
}

export interface PublicPage {
  slug: string;
  title: string;
  sections: Section[];
  publishedVersion?: number;
  updatedAt: string;
  redirectedFrom?: string;
  /** ADR 0236 (D1) — present only when a running experiment assigned this
   *  (consented) visitor a variant; the renderer echoes it onto the beacon. */
  experiment?: { experimentId: string; variant: string };
  seo: PublicPageSeo;
}

/**
 * Discriminated read result (UX_UPGRADE-site R2-G1/G2). "The page isn't
 * published" and "the read failed" are different facts with different UIs:
 * conflating them made a network blip render "Post not found — may have been
 * unpublished or moved", and a dead `/p/:slug` render a duplicate home page.
 */
export type PublicPageResult =
  | { status: 'ok'; page: PublicPage }
  /** 404/410 — the server answered: nothing is published at this slug. */
  | { status: 'notFound' }
  /** Network failure / 5xx / malformed body — we DON'T KNOW what's published. */
  | { status: 'error' };

/** Fetch a published public page as a discriminated result. `vk` (optional) is
 *  the anonymous visitor key — it opts the read into consent-gated experiment
 *  assignment (ADR 0236 D1); omitted ⇒ plain page. An unconfigured org reads as
 *  `notFound` (there is genuinely nothing published). */
export async function fetchPublicPageResult(orgId: string, slug: string, vk?: string | null): Promise<PublicPageResult> {
  if (!orgId) return { status: 'notFound' };
  try {
    const url = `${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}${vk ? `?vk=${encodeURIComponent(vk)}` : ''}`;
    // Public: no auth, no credentials — but DO send the content-locale preference
    // so the server's RFC 0103 negotiation (publishing/routes.ts) can localize.
    // `Accept-Language` is CORS-safelisted (no preflight). Gap-analysis fix A1.
    const requestLocale = getRequestLocale();
    const res = await fetch(url, requestLocale ? { headers: { 'accept-language': requestLocale } } : undefined);
    if (res.status === 404 || res.status === 410) return { status: 'notFound' };
    if (!res.ok) return { status: 'error' };
    const page = (await res.json()) as PublicPage;
    // Guard the top-level shape: a wire page whose `sections` isn't an array
    // would crash `sections.map`/`.length` at every consumer (pricing-'*' class).
    return { status: 'ok', page: { ...page, sections: Array.isArray(page.sections) ? page.sections : [] } };
  } catch {
    return { status: 'error' };
  }
}

/** Legacy convenience shape: page-or-null. Callers that render the same thing
 *  for "absent" and "failed" (the funnel viewer's own designed unavailable
 *  state) may keep this; surfaces that CLAIM absence must use
 *  `fetchPublicPageResult` instead. */
export async function fetchPublicPage(orgId: string, slug: string, vk?: string | null): Promise<PublicPage | null> {
  const r = await fetchPublicPageResult(orgId, slug, vk);
  return r.status === 'ok' ? r.page : null;
}
