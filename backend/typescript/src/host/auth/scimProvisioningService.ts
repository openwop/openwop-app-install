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
  getScimUserByExternalId,
  getUser,
  getUserByPrincipal,
  isActiveUser,
  setUserStatus,
  updateUser,
  type User,
} from '../../features/users/usersService.js';
import { clearLinkedSubjectDeny, denyLinkedSubject } from './subjectLinkService.js';

export type ScimOp = 'create-user' | 'assign-group' | 'deactivate-user' | 'link';
export const SCIM_OPS: readonly ScimOp[] = ['create-user', 'assign-group', 'deactivate-user', 'link'];

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
  /** RFC 0163 §B — the IdP entityID this SCIM connection is bound to (the SAML
   *  `<saml:Issuer>` the same IdP asserts). Recorded so the SAML decision path
   *  can trust-root-scope the cross-lane link. */
  idpEntityId?: string;
  email?: string;
  displayName?: string;
}): Promise<User> {
  return (await provisionUserWithOutcome(input)).user;
}

/** `provisionUser` plus whether the row was NEW (a joiner) or refreshed (a
 *  mover) — the SCIM routes append a `users.lifecycle.create` audit row only
 *  for the former (USERS-16, review NIT-1). */
export async function provisionUserWithOutcome(input: {
  tenantId: string;
  userName: string;
  externalId?: string;
  /** RFC 0163 §B — see `provisionUser`. */
  idpEntityId?: string;
  email?: string;
  displayName?: string;
}): Promise<{ user: User; created: boolean }> {
  const principalId = principalIdFor(input.userName);
  const existing = await getUserByPrincipal(input.tenantId, principalId);
  if (existing) {
    // Mover: refresh profile, keep id + status (no silent reactivation).
    const user =
      (await updateUser(existing.userId, {
        // ADR 0622 D7 — a SCIM-carried email is IdP-asserted, never self-set.
        ...(input.email !== undefined ? { email: input.email, emailProvenance: 'idp' as const } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.idpEntityId ? { idpEntityId: input.idpEntityId } : {}),
      })) ?? existing;
    return { user, created: false };
  }
  const user = await createUser({
    tenantId: input.tenantId,
    principalId,
    source: 'scim',
    // RFC 0159 (ADR 0613) — persist the opaque IdP-stable subject id so a
    // later externalId-addressed deactivation can resolve this record and the
    // subject-link deny can be keyed on it. (Was accepted but dropped before.)
    ...(input.externalId ? { externalId: input.externalId } : {}),
    // RFC 0163 §B (ADR 0620) — persist the SCIM lane's trust-root entityID.
    ...(input.idpEntityId ? { idpEntityId: input.idpEntityId } : {}),
    // ADR 0622 D7 review S1 — the SCIM provisioner IS an identity-provider lane.
    ...(input.email ? { email: input.email, emailProvenance: 'idp' as const } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
  return { user, created: true };
}

/**
 * RFC 0163 §B.1 — trust-root scoping for the SCIM⟷SAML subject link. Compares a
 * SAML assertion's signed `<saml:Issuer>` entityID against the IdP entityID the
 * SCIM connection was BOUND to when the externalId was provisioned, so an opaque
 * identifier that COLLIDES across two DIFFERENT IdPs never joins two principals.
 *
 * Outcomes:
 *   - `'no-link'`   — no SCIM record for this externalId ⇒ nothing to link; the
 *                     SAML assertion stands on its own merits (RFC 0159 behavior).
 *   - `'unbound'`   — a SCIM record exists but NO trust root is recorded for it
 *                     AND no config seat supplies one ⇒ the deployment has not
 *                     configured RFC 0163 binding; fall back to the RFC 0159
 *                     deny-only contract (no regression for existing deployments).
 *   - `'same-root'` — linked AND the SAML issuer matches the SCIM connection's
 *                     entityID ⇒ a valid link; proceed to the leaver-deny check.
 *   - `'mismatch'`  — linked and BOUND but the SAML issuer differs from (§B.1),
 *                     or cannot be verified against (§B.2 fail-closed: a bound
 *                     link whose SAML assertion carries no issuer), the SCIM
 *                     connection's entityID ⇒ the link MUST NOT form.
 *
 * `fallbackScimEntityId` is the config-bound entityID (`OPENWOP_SCIM_IDP_ENTITY_ID`)
 * for the real `/scim/v2` lane, which carries no per-record `idpUrl`.
 */
export type TrustRootOutcome = 'no-link' | 'unbound' | 'same-root' | 'mismatch';

export async function evaluateSubjectLinkTrustRoot(
  tenantId: string,
  externalId: string,
  samlIssuer: string | undefined,
  fallbackScimEntityId?: string,
): Promise<TrustRootOutcome> {
  const user = await getScimUserByExternalId(tenantId, externalId);
  if (!user) return 'no-link';
  const scimEntityId = user.idpEntityId ?? (fallbackScimEntityId || undefined);
  if (!scimEntityId) return 'unbound';
  if (!samlIssuer) return 'mismatch'; // §B.2 — a bound link we cannot verify fails closed.
  return scimEntityId === samlIssuer ? 'same-root' : 'mismatch';
}

/** Record SCIM group membership on the principal (group -> role membership;
 *  role RESOLUTION is ADR 0006). Idempotent. Returns null if the user is absent. */
export async function assignGroup(input: { tenantId: string; userName: string; group: string }): Promise<User | null> {
  const user = await getUserByPrincipal(input.tenantId, principalIdFor(input.userName));
  if (!user) return null;
  if (user.groups.includes(input.group)) return user;
  return updateUser(user.userId, { groups: [...user.groups, input.group] });
}

/**
 * Deactivate a SCIM user (leaver). Fail-closed: subsequent decisions deny.
 *
 * Addressable by EITHER the SCIM `userName` OR (RFC 0159 / ADR 0613) the opaque
 * IdP `externalId` — a leaver flow driven off the IdP's stable subject id. If the
 * resolved record carries an `externalId`, the cross-lane subject-link deny
 * (keyed on the USER's own tenant + externalId) is written so the SAML lane
 * fail-closes the linked identity — the combined leaver contract. This is the
 * ONE composition owner for the deny write on the SCIM lifecycle, so every
 * deactivation lane (the conformance seam, the real `/scim/v2` PATCH/DELETE via
 * `setScimActive`) records it.
 *
 * ORDERING + COMPENSATION (ADR 0617 D5 / `USERS-10`). Two durable writes, no
 * transaction. The DENY is written FIRST because it is the fail-closed lane:
 * a throw between the writes then leaves the SAML door SHUT and only the SCIM
 * status unresolved. THE IdP's RETRY IS THE COMPENSATION — a non-2xx makes the
 * IdP re-send the PATCH/DELETE, and BOTH keys are deterministic
 * (`denyKey = tenant:externalId`, `userId = hash(tenant, principal)`), so the
 * retry re-runs both writes idempotently. The reverse order (status first)
 * left the SAML lane OPEN until that retry. `setUserStatus` emits
 * `host.users.user.deactivated` (reason `scim`) ONLY on the transition, so the
 * retry cannot start a second offboarding run (ADR 0617 D1).
 */
export async function deactivateUser(input: { tenantId: string; userName?: string; externalId?: string }): Promise<User | null> {
  const user = input.externalId
    ? await getScimUserByExternalId(input.tenantId, input.externalId)
    : input.userName
      ? await getUserByPrincipal(input.tenantId, principalIdFor(input.userName))
      : null;
  if (!user) return null;
  if (user.externalId) await denyLinkedSubject(user.tenantId, user.externalId); // fail-closed lane FIRST
  return setUserStatus(user.userId, 'disabled', { reason: 'scim' });
}

/** Set a resolved SCIM user's active state (re-hire / un-suspend / leaver). The
 *  EXPLICIT lifecycle command — distinct from `provisionUser`, which never
 *  silently reactivates (review finding #5). RFC 0159 (ADR 0613): mirror the
 *  cross-lane subject-link deny — disable WRITES the deny, reactivate CLEARS it
 *  (re-hire), keyed on the user's own tenant + externalId. Same ordering rule as
 *  `deactivateUser` (ADR 0617 D5): on a leaver the deny is written FIRST; the
 *  IdP retry is the compensation for a throw between the two writes. On a
 *  re-hire the status write comes first (the fail-closed deny is cleared only
 *  once the account is genuinely active again). */
export async function setScimActive(user: User, active: boolean): Promise<User | null> {
  if (active) {
    const updated = await setUserStatus(user.userId, 'active', { reason: 'scim' });
    if (user.externalId) await clearLinkedSubjectDeny(user.tenantId, user.externalId);
    return updated;
  }
  if (user.externalId) await denyLinkedSubject(user.tenantId, user.externalId); // fail-closed lane FIRST
  return setUserStatus(user.userId, 'disabled', { reason: 'scim' });
}

/**
 * Resolve a SCIM resource addressed by EITHER the durable id we return from
 * create (`user:<sha256-prefix>` — the deterministic `userIdFor` hash, not a
 * UUID) OR the SCIM userName — so a standards-compliant IdP
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
