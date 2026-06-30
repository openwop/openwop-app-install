/**
 * CMS API client (ADR 0009). Org-scoped under /v1/host/openwop-app/cms/orgs/:orgId.
 * Section assets are Media-Library tokens (the editor offers the org's media
 * assets via `listMediaAssets`).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type PageStatus = 'draft' | 'in_review' | 'published' | 'archived';
export type SectionType = 'hero' | 'richText' | 'image' | 'cta' | 'columns';
export const SECTION_TYPES: readonly SectionType[] = ['hero', 'richText', 'image', 'cta', 'columns'];
export interface Section {
  sectionId: string;
  type: SectionType;
  data: Record<string, unknown>;
  /** Sparse per-locale overrides (RFC 0103 / ADR 0064); absent on non-localized sections. */
  localizations?: Record<string, Record<string, unknown>>;
}

/** Per-org content-locale settings (ADR 0064). Invariant: baseLocale ∉ supportedLocales. */
export interface LanguageSettings {
  baseLocale: string;
  supportedLocales: string[];
  autoTranslateOnPublish: boolean;
}
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

/** Translate a section's base data into a target locale (ADR 0064 Phase 3) via
 *  the managed provider. Returns the sanitized draft overlay to review before
 *  saving. Throws if translation is unavailable (managed provider not
 *  configured / capped) — the caller degrades to manual editing. */
export async function translateSection(
  orgId: string,
  input: { sectionType: SectionType; data: Record<string, unknown>; targetLocale: string },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(orgId)}/translate-section`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ overlay: Record<string, unknown> }>(res, 'translateSection')).overlay;
}

/** Content-locale settings for the org (ADR 0064). GET is always available
 *  (returns a default skeleton); PUT requires the `cms-localization` toggle +
 *  the admin tier. */
export async function getLanguageSettings(orgId: string): Promise<LanguageSettings> {
  const res = await fetch(`${base(orgId)}/language-settings`, fetchOpts({ headers: authedHeaders() }));
  return asJson<LanguageSettings>(res, 'getLanguageSettings');
}
export async function putLanguageSettings(
  orgId: string,
  patch: { baseLocale?: string; supportedLocales?: string[]; autoTranslateOnPublish?: boolean },
): Promise<LanguageSettings> {
  const res = await fetch(`${base(orgId)}/language-settings`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<LanguageSettings>(res, 'putLanguageSettings');
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
  return `${config.baseUrl}/v1/host/openwop-app/assets/${encodeURIComponent(token)}`;
}
