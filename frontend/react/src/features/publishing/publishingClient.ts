/**
 * Publishing & SEO API client (ADR 0012). Authed SEO CRUD under
 * /v1/host/openwop-app/publishing/orgs/:orgId; reads CMS pages + Media assets (to
 * attach SEO + pick OG images) and surfaces the PUBLIC URLs.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type PageStatus = 'draft' | 'in_review' | 'published' | 'archived';
export interface CmsPageRef { pageId: string; title: string; slug: string; status: PageStatus }
export interface MediaAssetRef { assetId: string; name: string; serveUrl: string; serveToken?: string }

export interface PageSeo {
  metaTitle?: string;
  metaDescription?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageToken?: string;
  canonicalUrl?: string;
  noindex: boolean;
}

const root = `${config.baseUrl}/v1/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

/** The org's CMS pages (publishing attaches SEO to them). */
export async function listPages(orgId: string): Promise<CmsPageRef[]> {
  const res = await fetch(`${root}/cms/orgs/${encodeURIComponent(orgId)}/pages`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ pages: CmsPageRef[] }>(res, 'listPages')).pages;
}

/** The org's Media assets (OG-image picker). Returns [] if Media is off. */
export async function listMediaAssets(orgId: string): Promise<MediaAssetRef[]> {
  try {
    const res = await fetch(`${root}/media/orgs/${encodeURIComponent(orgId)}/assets`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return [];
    return ((await res.json()) as { assets: MediaAssetRef[] }).assets ?? [];
  } catch { return []; }
}

const seoPath = (orgId: string, pageId: string): string =>
  `${root}/publishing/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(pageId)}/seo`;

export async function getSeo(orgId: string, pageId: string): Promise<PageSeo | null> {
  const res = await fetch(seoPath(orgId, pageId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ seo: PageSeo | null }>(res, 'getSeo')).seo;
}

export async function putSeo(orgId: string, pageId: string, seo: PageSeo): Promise<PageSeo> {
  const res = await fetch(seoPath(orgId, pageId), fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(seo) }));
  return (await asJson<{ seo: PageSeo }>(res, 'putSeo')).seo;
}

// Public URLs (relative to the API base) — for display + copy.
export const publicPageUrl = (orgId: string, slug: string): string => `${root}/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`;
export const sitemapUrl = (orgId: string): string => `${root}/public/${encodeURIComponent(orgId)}/sitemap.xml`;
export const feedUrl = (orgId: string): string => `${root}/public/${encodeURIComponent(orgId)}/feed.rss`;
