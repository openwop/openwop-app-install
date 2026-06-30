/**
 * Collaboration / Comments API client (ADR 0021). Authed org-scoped threads under
 * /v1/host/openwop-app/comments/orgs/:orgId. No public surface. The resource picker
 * composes the CMS + KB clients (listPages / listCollections) — comments reference
 * those resources, they never copy their data.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type ResourceType = 'cms_page' | 'kb_collection';
export const RESOURCE_TYPES: readonly ResourceType[] = ['cms_page', 'kb_collection'];

export type CommentStatus = 'open' | 'resolved';
export interface Comment {
  commentId: string;
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  parentId?: string;
  body: string;
  authorId: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
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

const base = (orgId: string): string => `${root}/comments/orgs/${encodeURIComponent(orgId)}/comments`;

export async function listThread(orgId: string, resourceType: ResourceType, resourceId: string): Promise<Comment[]> {
  const q = new URLSearchParams({ resourceType, resourceId });
  const res = await fetch(`${base(orgId)}?${q.toString()}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ comments: Comment[] }>(res, 'listThread')).comments;
}

export async function postComment(orgId: string, input: { resourceType: ResourceType; resourceId: string; body: string; parentId?: string }): Promise<Comment> {
  const res = await fetch(base(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Comment>(res, 'postComment');
}

export async function updateComment(orgId: string, commentId: string, patch: { body?: string; status?: CommentStatus }): Promise<Comment> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(commentId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Comment>(res, 'updateComment');
}

export async function deleteComment(orgId: string, commentId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(commentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteComment returned ${res.status}`);
}
