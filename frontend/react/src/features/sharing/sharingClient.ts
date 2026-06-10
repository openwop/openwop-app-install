/**
 * Sharing API client (ADR 0013). Authed link management under
 * /v1/host/sample/sharing/orgs/:orgId; reads CMS pages + KB collections to pick a
 * resource, and surfaces the PUBLIC /shared/:token URL.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type ResourceType = 'cms_page' | 'kb_collection';
export interface ResourceRef { id: string; label: string }

export interface ShareLink {
  token: string;
  resourceType: ResourceType;
  resourceId: string;
  label?: string;
  cardTitle?: string;
  createdAt: string;
  expiresAt?: string;
  revoked: boolean;
}

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

/** Pickable resources of a given type for the org (best-effort — [] if the
 *  source feature is off). */
export async function listResources(orgId: string, type: ResourceType): Promise<ResourceRef[]> {
  try {
    if (type === 'cms_page') {
      const res = await fetch(`${root}/cms/orgs/${encodeURIComponent(orgId)}/pages`, fetchOpts({ headers: authedHeaders() }));
      if (!res.ok) return [];
      const { pages } = (await res.json()) as { pages: Array<{ pageId: string; title: string; status: string }> };
      return (pages ?? []).map((p) => ({ id: p.pageId, label: `${p.title} (${p.status})` }));
    }
    const res = await fetch(`${root}/kb/orgs/${encodeURIComponent(orgId)}/collections`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return [];
    const { collections } = (await res.json()) as { collections: Array<{ collectionId: string; name: string }> };
    return (collections ?? []).map((c) => ({ id: c.collectionId, label: c.name }));
  } catch { return []; }
}

const linksBase = (orgId: string): string => `${root}/sharing/orgs/${encodeURIComponent(orgId)}/links`;

export async function listLinks(orgId: string): Promise<ShareLink[]> {
  const res = await fetch(linksBase(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ links: ShareLink[] }>(res, 'listLinks')).links;
}

export async function createLink(orgId: string, input: { resourceType: ResourceType; resourceId: string; label?: string; expiresInDays?: number }): Promise<ShareLink> {
  const res = await fetch(linksBase(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<ShareLink>(res, 'createLink');
}

export async function revokeLink(orgId: string, token: string): Promise<void> {
  const res = await fetch(`${linksBase(orgId)}/${encodeURIComponent(token)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`revokeLink returned ${res.status}`);
}

/** The public, unauthenticated share URL for a token. */
export const sharedUrl = (token: string): string => `${root}/shared/${encodeURIComponent(token)}`;
