/**
 * ADR 1099 P1 — the firm's side of a project's client access, over the host
 * collaborator routes (`/host/openwop-app/orgs/:orgId/collaborators`, ADR 1099
 * P0b). The server holds every rule: inviting needs `host:members:manage` on the
 * project's org, and a `project` grant needs the `projects.client-portal` switch.
 * A refusal is a 404 (uniform), which the tab reads as "you cannot manage this".
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type ProjectGrantAction = 'view' | 'comment';
/** The collaborator kinds a project invite offers: a client, or an outside firm (a builder). */
export type ProjectCollaboratorKind = 'client-stakeholder' | 'vendor';

export interface ProjectGrant {
  grantId: string; collaboratorId: string;
  resource: { kind: string; id: string };
  actions: string[];
  expiresAt: string;
  status: 'active' | 'revoked';
  createdAt: string;
  /** Which party the grant is for (ADR 1099), from the labels the workspace's features offer. */
  audience?: string;
}
export interface OrgCollaborator {
  collaboratorId: string; kind: string;
  email: string; displayName: string; company?: string;
  status: 'invited' | 'active' | 'suspended' | 'revoked';
  mode: 'signed-in' | 'link-only'; accepted: boolean;
  grants: ProjectGrant[];
}

export class ClientAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { message?: unknown } | undefined;
    throw new ClientAccessError(typeof body?.message === 'string' ? body.message : '', res.status);
  }
  return res.json() as Promise<T>;
}

const base = (orgId: string): string => `${config.baseUrl}/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;
const json = (method: string, body: unknown) => fetchOpts({ method, headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });

export async function listOrgCollaborators(orgId: string): Promise<OrgCollaborator[]> {
  return (await asJson<{ collaborators: OrgCollaborator[] }>(await fetch(base(orgId), fetchOpts({ headers: authedHeaders() })))).collaborators;
}

/** The invite token comes back ONCE; the caller turns it into the link to send. */
export async function inviteToOrg(orgId: string, body: { kind: ProjectCollaboratorKind; email: string; displayName: string; company?: string }): Promise<{ collaborator: OrgCollaborator; invite: { token: string; expiresAt?: string } }> {
  return asJson(await fetch(base(orgId), json('POST', body)));
}

export async function grantProject(orgId: string, collaboratorId: string, projectId: string, actions: ProjectGrantAction[], expiresInDays: number, audience?: string): Promise<ProjectGrant> {
  const body = { resource: { kind: 'project', id: projectId }, actions, expiresInDays, ...(audience ? { audience } : {}) };
  return (await asJson<{ grant: ProjectGrant }>(await fetch(`${base(orgId)}/${encodeURIComponent(collaboratorId)}/grants`, json('POST', body)))).grant;
}

/** ADR 1099 — the audience labels a project grant may carry here (from the
 *  workspace's features). An empty list means the workspace offers none. */
export async function listProjectAudiences(orgId: string): Promise<string[]> {
  const out = await asJson<{ kinds: Array<{ kind: string; audiences?: string[] }> }>(await fetch(`${base(orgId)}/grantable`, fetchOpts({ headers: authedHeaders() })));
  return out.kinds.find((k) => k.kind === 'project')?.audiences ?? [];
}

export async function revokeProjectGrant(orgId: string, collaboratorId: string, grantId: string): Promise<void> {
  await asJson<unknown>(await fetch(`${base(orgId)}/${encodeURIComponent(collaboratorId)}/grants/${encodeURIComponent(grantId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })));
}

/** The link the invitee opens (the host's collab accept page). */
export function projectInviteUrl(token: string): string {
  return `${window.location.origin}/collab/accept/${encodeURIComponent(token)}`;
}

/** ADR 1099 D7 — one outside collaborator's thread with the firm on this project. */
export interface ClientThread {
  collaboratorId: string;
  label: string;
  entries: Array<{ entryId: string; author: { kind: 'collaborator'; label: string } | { kind: 'member'; userId: string }; text: string; createdAt: string }>;
}
const threadsUrl = (projectId: string): string => `${config.baseUrl}/host/openwop-app/projects/${encodeURIComponent(projectId)}/client-threads`;

/** Every collaborator thread of the project (a 404 means the switch is off or no access). */
export async function listClientThreads(projectId: string): Promise<ClientThread[]> {
  return (await asJson<{ threads: ClientThread[] }>(await fetch(threadsUrl(projectId), fetchOpts({ headers: authedHeaders() })))).threads;
}

/** A member's reply to one collaborator; it joins at once. */
export async function replyToClient(projectId: string, collaboratorId: string, text: string): Promise<void> {
  await asJson<unknown>(await fetch(`${threadsUrl(projectId)}/${encodeURIComponent(collaboratorId)}`, json('POST', { text })));
}
