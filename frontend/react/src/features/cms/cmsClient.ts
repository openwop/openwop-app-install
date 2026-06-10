/**
 * CMS API client (ADR 0009). Org-scoped under /v1/host/sample/cms/orgs/:orgId.
 * Section assets are Media-Library tokens (the editor offers the org's media
 * assets via `listMediaAssets`).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type PageStatus = 'draft' | 'in_review' | 'published' | 'archived';
export type SectionType = 'hero' | 'richText' | 'image' | 'cta' | 'columns';
export const SECTION_TYPES: readonly SectionType[] = ['hero', 'richText', 'image', 'cta', 'columns'];
export interface Section { sectionId: string; type: SectionType; data: Record<string, unknown> }
export interface Page {
  pageId: string;
  title: string;
  slug: string;
  status: PageStatus;
  sections: Section[];
  version: number;
  publishedVersion?: number;
  updatedAt: string;
}
export interface PageVersion { versionId: string; version: number; publishedAt: string; publishedBy: string }
export interface MediaAssetRef { assetId: string; name: string; serveUrl: string; serveToken?: string }
export type WorkflowAction = 'submit' | 'approve' | 'reject' | 'publish' | 'archive' | 'unpublish';

const root = `${config.baseUrl}/v1/host/sample`;
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

const base = (orgId: string): string => `${root}/cms/orgs/${encodeURIComponent(orgId)}`;

export async function listPages(orgId: string): Promise<Page[]> {
  const res = await fetch(`${base(orgId)}/pages`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ pages: Page[] }>(res, 'listPages')).pages;
}
export async function getPage(orgId: string, pageId: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<Page>(res, 'getPage');
}
export async function createPage(orgId: string, title: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ title }) }));
  return asJson<Page>(res, 'createPage');
}
export async function savePage(orgId: string, pageId: string, patch: { title?: string; slug?: string; sections?: Section[] }): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Page>(res, 'savePage');
}
export async function deletePage(orgId: string, pageId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deletePage');
}
export async function transition(orgId: string, pageId: string, action: WorkflowAction): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/${action}`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<Page>(res, action);
}
export async function listVersions(orgId: string, pageId: string): Promise<PageVersion[]> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/versions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ versions: PageVersion[] }>(res, 'listVersions')).versions;
}
export async function restoreVersion(orgId: string, pageId: string, versionId: string): Promise<Page> {
  const res = await fetch(`${base(orgId)}/pages/${encodeURIComponent(pageId)}/restore/${encodeURIComponent(versionId)}`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<Page>(res, 'restoreVersion');
}

/** The org's media assets, for the section image/hero token picker (best-effort —
 *  empty if the media feature is off). */
export async function listMediaAssets(orgId: string): Promise<MediaAssetRef[]> {
  try {
    const res = await fetch(`${root}/media/orgs/${encodeURIComponent(orgId)}/assets`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return [];
    return ((await res.json()) as { assets: MediaAssetRef[] }).assets ?? [];
  } catch {
    return [];
  }
}

/** Absolute serve URL for an asset's token (for section image previews). */
export function assetUrl(token: string): string {
  return `${config.baseUrl}/v1/host/sample/assets/${encodeURIComponent(token)}`;
}
