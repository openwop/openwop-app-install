/**
 * Public front-page client (ADR 0027). Reads the designated site-org's PUBLISHED
 * home page through the EXISTING unauthenticated Publishing API (ADR 0012):
 *   GET /v1/host/openwop-app/public/:orgId/pages/:slug
 * No auth headers, no credentials — the surface is public by definition
 * (published-only; drafts/archived 404). The shape mirrors the backend
 * `PublicPage` projection (sections + merged SEO).
 */
import { config } from '../../client/config.js';
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
  seo: PublicPageSeo;
}

/** Fetch a published public page, or `null` when unconfigured / unpublished /
 *  unreachable (the caller renders fallback content — the front page never blank). */
export async function fetchPublicPage(orgId: string, slug: string): Promise<PublicPage | null> {
  if (!orgId) return null;
  try {
    const url = `${config.baseUrl}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`;
    const res = await fetch(url); // public: no auth, no credentials
    if (!res.ok) return null;
    return (await res.json()) as PublicPage;
  } catch {
    return null;
  }
}
