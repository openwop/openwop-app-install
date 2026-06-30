/**
 * Sharing API client (ADR 0013). Authed link management under
 * /v1/host/openwop-app/sharing/orgs/:orgId; reads CMS pages + KB collections to pick a
 * resource, and surfaces the PUBLIC /shared/:token URL.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
// Mirrors the backend's authoritative RESOURCE_TYPES (sharingService.ts): the host
// resolves all of these. The mint picker currently offers only the two with a
// `listResources` source; the others arrive via API/feature flows and MUST still
// render a correct label in the link list (ADR 0122 Phase 4 / ADR 0116 2b).
export type ResourceType = 'cms_page' | 'kb_collection' | 'document' | 'conversation' | 'prompt';
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
    // ADR 0122 Phase 5 — the backend resolves document/conversation/prompt shares; the
    // picker now lists them too (each via its owning feature's list endpoint).
    if (type === 'document') {
      const res = await fetch(`${root}/documents/orgs/${encodeURIComponent(orgId)}/documents`, fetchOpts({ headers: authedHeaders() }));
      if (!res.ok) return [];
      const { documents } = (await res.json()) as { documents: Array<{ documentId: string; title: string }> };
      return (documents ?? []).map((d) => ({ id: d.documentId, label: d.title }));
    }
    if (type === 'prompt') {
      const res = await fetch(`${root}/prompts/orgs/${encodeURIComponent(orgId)}/entries`, fetchOpts({ headers: authedHeaders() }));
      if (!res.ok) return [];
      const { entries } = (await res.json()) as { entries: Array<{ entryId: string; name: string }> };
      return (entries ?? []).map((e) => ({ id: e.entryId, label: e.name }));
    }
    if (type === 'conversation') {
      // Conversations are tenant-scoped (no org path); the backend resolver validates
      // tenant membership on mint.
      const res = await fetch(`${root}/chat/sessions`, fetchOpts({ headers: authedHeaders() }));
      if (!res.ok) return [];
      const { sessions } = (await res.json()) as { sessions: Array<{ sessionId: string; title: string }> };
      return (sessions ?? []).map((s) => ({ id: s.sessionId, label: s.title }));
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

/** The raw public API endpoint for a token (returns JSON). */
export const sharedUrl = (token: string): string => `${root}/shared/${encodeURIComponent(token)}`;

/** The user-facing SPA viewer URL for a token — what you hand to a recipient
 *  (renders the read-only page, NOT raw JSON). ADR 0122 Phase 6. */
export const sharedPageUrl = (token: string): string => `${window.location.origin}/shared/${encodeURIComponent(token)}`;

/** A resolved public share (the shape the public, unauthenticated endpoint returns). */
export interface SharedResource { resourceType: ResourceType; label?: string; resource: Record<string, unknown> }

/** Resolve a share token on the PUBLIC, unauthenticated surface (no auth headers —
 *  the unguessable token is the credential). Used by the public viewer page. */
export async function resolveSharedPublic(token: string): Promise<SharedResource> {
  const res = await fetch(sharedUrl(token));
  if (res.status === 404 || res.status === 410) throw new Error('not-found');
  if (!res.ok) throw new Error(`resolveShared returned ${res.status}`);
  return (await res.json()) as SharedResource;
}
