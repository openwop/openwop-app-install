/**
 * SCIM 2.0 provisioning service — `openwop-auth-scim` (ADR 0002, Phase 4).
 *
 * Maps SCIM joiner/mover/leaver operations onto the durable identity store
 * (usersService), per RFC 0050 §B:
 *   - create-user     -> upsert an RFC 0048 principal (source `scim`, active)
 *   - assign-group    -> record SCIM group membership on the principal (a SCIM
 *                        group maps to an RFC 0049 role; the group->role
 *                        RESOLUTION is ADR 0006 / RBAC — here we capture raw
 *                        membership, consistent with finding H6)
 *   - deactivate-user -> disable the principal; a deactivated principal's
 *                        subsequent authorization decisions MUST deny
 *                        (fail-closed, composing with RFC 0049 §C — finding H5)
 *
 * The principal id is `scim:<userName>`, stable across operations so a
 * mover/leaver targets the same record a joiner created (replay-safe, finding
 * C4). Reuses usersService so SCIM-provisioned and SSO/password identities share
 * one User store and one lifecycle.
 */

import {
  createUser,
  getUser,
  getUserByPrincipal,
  isActiveUser,
  setUserStatus,
  updateUser,
  type User,
} from '../../features/users/usersService.js';

export type ScimOp = 'create-user' | 'assign-group' | 'deactivate-user';
export const SCIM_OPS: readonly ScimOp[] = ['create-user', 'assign-group', 'deactivate-user'];

/** Default SCIM user the conformance seam provisions when none is supplied —
 *  deterministic so create-user is self-contained and idempotent. */
export const DEFAULT_SCIM_USER = { userName: 'scim.user@example.test', externalId: 'scim-ext-1', displayName: 'SCIM User' };

function principalIdFor(userName: string): string {
  return `scim:${userName.trim().toLowerCase()}`;
}

/** Upsert a SCIM user onto an RFC 0048 principal (joiner / mover). */
export async function provisionUser(input: {
  tenantId: string;
  userName: string;
  externalId?: string;
  email?: string;
  displayName?: string;
}): Promise<User> {
  const principalId = principalIdFor(input.userName);
  const existing = await getUserByPrincipal(input.tenantId, principalId);
  if (existing) {
    // Mover: refresh profile, keep id + status (no silent reactivation).
    return (
      (await updateUser(existing.userId, {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      })) ?? existing
    );
  }
  return createUser({
    tenantId: input.tenantId,
    principalId,
    source: 'scim',
    ...(input.email ? { email: input.email } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
}

/** Record SCIM group membership on the principal (group -> role membership;
 *  role RESOLUTION is ADR 0006). Idempotent. Returns null if the user is absent. */
export async function assignGroup(input: { tenantId: string; userName: string; group: string }): Promise<User | null> {
  const user = await getUserByPrincipal(input.tenantId, principalIdFor(input.userName));
  if (!user) return null;
  if (user.groups.includes(input.group)) return user;
  return updateUser(user.userId, { groups: [...user.groups, input.group] });
}

/** Deactivate a SCIM user (leaver). Fail-closed: subsequent decisions deny. */
export async function deactivateUser(input: { tenantId: string; userName: string }): Promise<User | null> {
  const user = await getUserByPrincipal(input.tenantId, principalIdFor(input.userName));
  if (!user) return null;
  return setUserStatus(user.userId, 'disabled');
}

/** Set a resolved SCIM user's active state (re-hire / un-suspend / leaver). The
 *  EXPLICIT lifecycle command — distinct from `provisionUser`, which never
 *  silently reactivates (review finding #5). */
export async function setScimActive(user: User, active: boolean): Promise<User | null> {
  return setUserStatus(user.userId, active ? 'active' : 'disabled');
}

/**
 * Resolve a SCIM resource addressed by EITHER the durable id we return from
 * create (`user:<uuid>`) OR the SCIM userName — so a standards-compliant IdP
 * that stores and re-sends the returned `id` resolves the same record a
 * userName-addressed call would (review finding #4).
 */
export async function resolveScimUser(tenantId: string, idOrUserName: string): Promise<User | null> {
  // SCIM manages ONLY SCIM-provisioned identities (review finding #5): a bearer
  // holder must NOT be able to deactivate a password/OIDC user that merely
  // shares the tenant. Both lookup paths therefore require `source === 'scim'`.
  if (idOrUserName.startsWith('user:')) {
    const byId = await getUser(idOrUserName);
    if (byId && byId.tenantId === tenantId && byId.source === 'scim') return byId;
  }
  const byName = await getUserByPrincipal(tenantId, principalIdFor(idOrUserName));
  return byName?.source === 'scim' ? byName : null;
}

/** The SCIM userName behind a resolved record (the `scim:` principal stripped) —
 *  so responses echo the real userName, not the durable id (review finding #8). */
export function scimUserNameOf(user: User): string {
  return user.principalId.replace(/^scim:/, '');
}

/** Can the host still resolve this SCIM principal to an ACTIVE identity?
 *  False after deactivation — the fail-closed proof point (RFC 0050 §B). */
export async function isPrincipalResolvable(tenantId: string, userName: string): Promise<boolean> {
  return isActiveUser(tenantId, principalIdFor(userName));
}
