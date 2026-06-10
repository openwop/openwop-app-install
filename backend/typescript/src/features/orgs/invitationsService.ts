/**
 * Org invitations (ADR 0004, reconciled). The Organizations / members / roles
 * model is owned by the pre-existing `accessControl` surface (RFC 0049 roles —
 * tenant is the isolation boundary, an org is a grouping inside it). This module
 * adds the ONE thing accessControl lacks: an email-token invitation flow to
 * onboard a person as a member of an org. It owns NO org/member state — it
 * DELEGATES to `accessControlService` (single source of truth, finding: the
 * orgs namespace collision). The original ADR-0004 draft's org===tenant model,
 * membership tier, active-org switch, and personal-org were removed as
 * duplicative of accessControl; see the amended ADR.
 *
 * SECRET HANDLING: tokens are returned once and stored only as sha256 hashes
 * with a 7-day expiry. ACCEPT is fail-closed: the accepting user MUST own the
 * invited email, and the invite is single-use.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createMember, getOrg, isBuiltInRoleId, type OrgMember } from '../../host/accessControlService.js';
import type { User } from '../users/usersService.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Roles an invitation may grant — built-in accessControl roles, never `owner`
 *  (ownership is granted explicitly through accessControl, not by invite). */
export type InvitableRole = 'viewer' | 'editor' | 'admin';
const INVITABLE_ROLES: readonly InvitableRole[] = ['viewer', 'editor', 'admin'];

export interface OrgInvitation {
  inviteId: string;
  tenantId: string;
  orgId: string;
  email: string;
  role: InvitableRole;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

const invites = new DurableCollection<OrgInvitation>('orgs:invite', (i) => i.inviteId);

export class InviteError extends Error {
  constructor(
    public readonly code: 'not_found' | 'forbidden' | 'validation' | 'invalid_invite',
    message: string,
  ) {
    super(message);
    this.name = 'InviteError';
  }
}

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

function parseRole(value: unknown): InvitableRole {
  if (typeof value === 'string' && (INVITABLE_ROLES as readonly string[]).includes(value) && isBuiltInRoleId(value)) {
    return value as InvitableRole;
  }
  throw new InviteError('validation', `Field \`role\` MUST be one of ${INVITABLE_ROLES.join(', ')}.`);
}

/** The accessControl org, scoped to the caller's tenant (IDOR guard) — the org
 *  must exist AND belong to this tenant, else 404 (no existence leak). */
async function requireOrgInTenant(tenantId: string, orgId: string): Promise<void> {
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) throw new InviteError('not_found', 'Org not found.');
}

export async function createInvitation(input: { tenantId: string; orgId: string; email: string; role: unknown }): Promise<{ invite: OrgInvitation; token: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new InviteError('validation', 'Invite `email` is required.');
  const role = parseRole(input.role);
  await requireOrgInTenant(input.tenantId, input.orgId);
  // At most one live invite per (org, email): replace prior pending ones so an
  // old token can't re-add a removed member.
  for (const stale of (await invites.list()).filter((i) => i.orgId === input.orgId && i.email === email)) {
    await invites.delete(stale.inviteId);
  }
  const token = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const invite: OrgInvitation = {
    inviteId: `inv:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    email,
    role,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    createdAt: now,
  };
  await invites.put(invite);
  return { invite, token };
}

export async function listInvitations(tenantId: string, orgId: string): Promise<OrgInvitation[]> {
  await requireOrgInTenant(tenantId, orgId);
  return (await invites.list()).filter((i) => i.tenantId === tenantId && i.orgId === orgId);
}

export async function revokeInvitation(tenantId: string, orgId: string, inviteId: string): Promise<void> {
  const inv = await invites.get(inviteId);
  if (!inv || inv.tenantId !== tenantId || inv.orgId !== orgId) throw new InviteError('not_found', 'Invitation not found.');
  await invites.delete(inviteId);
}

/**
 * Accept an invite → become an accessControl member of the org (delegated).
 * Fail-closed: the accepting user MUST own the invited email; single-use; the
 * org must still exist. The new member binds to the user's `userId` (subject)
 * with the invited role, so accessControl's RFC 0049 scope resolution applies.
 */
export async function acceptInvitation(token: string, user: User): Promise<OrgMember> {
  const inv = (await invites.list()).find((i) => i.tokenHash === hashToken(token));
  if (!inv || Date.parse(inv.expiresAt) < Date.now()) {
    throw new InviteError('invalid_invite', 'The invitation is invalid or expired.');
  }
  if (!(await getOrg(inv.orgId))) {
    await invites.delete(inv.inviteId);
    throw new InviteError('invalid_invite', 'The invitation is for an org that no longer exists.');
  }
  if (!user.email || user.email.trim().toLowerCase() !== inv.email) {
    throw new InviteError('forbidden', 'This invitation was issued to a different email.');
  }
  const member = await createMember({
    tenantId: inv.tenantId,
    orgId: inv.orgId,
    subject: user.userId, // RFC 0048 stable subject (ADR 0003) — roles apply when this principal acts
    displayName: user.displayName ?? user.email,
    email: user.email,
    roles: [inv.role],
  });
  await invites.delete(inv.inviteId); // single-use
  return member;
}

/** Test-only: clear invitations. */
export async function __resetOrgInvites(): Promise<void> {
  await invites.__clear();
}
