/**
 * ADR 0958 matrix row 10 — the agency side of external collaborators, under
 * `/host/openwop-app/campaign-ops/clients/:orgId/collaborators`. Every route is
 * `host:members:manage` on the client and the `campaign-ops.external-collab`
 * toggle (server-enforced). Failures throw `CampaignOpsError` with the server's
 * own message (a 404 "not enabled" means collaborators are off).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { asJson } from './campaignOpsClient.js';

export type CollaboratorKind = 'vendor' | 'freelancer' | 'client-stakeholder';
export type CollaboratorStatus = 'invited' | 'active' | 'suspended' | 'revoked';
export type GrantAction = 'view' | 'comment' | 'upload' | 'mark-ready' | 'decide';

export interface CollaboratorGrant {
  grantId: string; collaboratorId: string;
  resource: { kind: string; id: string };
  actions: GrantAction[];
  expiresAt: string;
  status: 'active' | 'revoked';
  createdAt: string; revokedAt?: string;
}
export interface Collaborator {
  collaboratorId: string; orgId: string; kind: CollaboratorKind;
  email: string; displayName: string; company?: string;
  status: CollaboratorStatus; mode: 'signed-in' | 'link-only'; accepted: boolean;
  createdAt: string; updatedAt: string;
  grants: CollaboratorGrant[];
}
export interface GrantableKind { kind: string; actions: GrantAction[]; items: Array<{ id: string; title: string }> }

const base = (orgId: string): string => `${config.baseUrl}/host/openwop-app/campaign-ops/clients/${encodeURIComponent(orgId)}/collaborators`;
const json = (method: string, body: unknown) => fetchOpts({ method, headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });

export async function listCollaborators(orgId: string): Promise<Collaborator[]> {
  return (await asJson<{ collaborators: Collaborator[] }>(await fetch(base(orgId), fetchOpts({ headers: authedHeaders() })))).collaborators;
}
export async function listGrantable(orgId: string): Promise<GrantableKind[]> {
  return (await asJson<{ kinds: GrantableKind[] }>(await fetch(`${base(orgId)}/grantable`, fetchOpts({ headers: authedHeaders() })))).kinds;
}
/** The invite token comes back ONCE; the caller turns it into the link to send. */
export async function inviteCollaborator(orgId: string, body: { kind: CollaboratorKind; email: string; displayName: string; company?: string }): Promise<{ collaborator: Collaborator; invite: { token: string; expiresAt?: string } }> {
  return asJson(await fetch(base(orgId), json('POST', body)));
}
export async function grantCollaborator(orgId: string, collaboratorId: string, body: { resource: { kind: string; id: string }; actions: GrantAction[]; expiresInDays: number }): Promise<CollaboratorGrant> {
  return (await asJson<{ grant: CollaboratorGrant }>(await fetch(`${base(orgId)}/${encodeURIComponent(collaboratorId)}/grants`, json('POST', body)))).grant;
}
export async function revokeCollaboratorGrant(orgId: string, collaboratorId: string, grantId: string): Promise<void> {
  await asJson<unknown>(await fetch(`${base(orgId)}/${encodeURIComponent(collaboratorId)}/grants/${encodeURIComponent(grantId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })));
}
export async function setCollaboratorStatus(orgId: string, collaboratorId: string, status: 'active' | 'suspended' | 'revoked'): Promise<void> {
  await asJson<unknown>(await fetch(`${base(orgId)}/${encodeURIComponent(collaboratorId)}/status`, json('POST', { status })));
}
/** The link the invitee opens (the collab accept page). */
export function inviteUrl(token: string): string {
  return `${window.location.origin}/collab/accept/${encodeURIComponent(token)}`;
}
