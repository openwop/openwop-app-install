/**
 * Shared identity guards for the users feature (review finding #10 — these were
 * duplicated across the feature's route modules).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { getUser, getUserByPrincipal, upsertFromPrincipal, resolveCanonicalUserForTenant, type User, type UserSource } from './usersService.js';
import { holdsOwnerRoleInTenant } from '../../host/accessControlService.js';
import { tenantOf } from '../../host/requestSubject.js';

/** Principal shapes that represent a DURABLE identity and may be reconciled into
 *  a `User`. A transient `session:<sid>` (or any unknown shape) MUST NOT — that is
 *  the identity fragmentation ADR 0003 eliminates (it is how a stray
 *  `session:<sid>` "manual" user gets minted). Maps each prefix to its source. */
const DURABLE_PRINCIPALS: ReadonlyArray<readonly [string, UserSource]> = [
  ['oidc:', 'oidc'],
  ['user:', 'oidc'], // already-canonical subject (re-resolved by id above, normally)
  ['password:', 'password'],
  ['saml:', 'saml'],
  ['scim:', 'scim'],
];

/** The `UserSource` to reconcile a principal under, or `null` if its shape is NOT
 *  a durable identity (e.g. a transient `session:<sid>`) and must be refused. Pure
 *  + exported so the guard is unit-testable without an Express `Request`. */
export function reconcilableSource(principalId: string): UserSource | null {
  return DURABLE_PRINCIPALS.find(([prefix]) => principalId.startsWith(prefix))?.[1] ?? null;
}

/** An anonymous demo session — no durable identity (review finding #8). A session
 *  BOUND to a durable user (`req.userId`, ADR 0003) is never anonymous, even if
 *  its home tenant is an `anon:`-derived id (a password user who signed up in an
 *  anon session keeps that tenant) — the route harness caught a tenant-prefix-only
 *  check 401'ing legitimately-bound users (and breaking /me for them). */
export function isAnonymous(req: Request): boolean {
  if (req.userId) return false;
  return (req.tenantId ?? '').startsWith('anon:');
}

/** Refuse anonymous sessions on any route that reads or mutates a durable
 *  identity (reviews findings #4/#8) — minting/granting under a throwaway
 *  per-session principal is never durable identity. */
export function requireSignedIn(req: Request): void {
  if (isAnonymous(req)) {
    throw new OpenwopError('sign_in_required', 'Sign in to access your account.', 401, {});
  }
}

/** The caller's stable principal id, fail-closed: a route that calls this MUST
 *  have passed `requireSignedIn` first, so a missing principal is a bug, not a
 *  synthetic per-tenant fallback (review finding #10 — the old `tenant:<id>`
 *  fallback was dead and would have collapsed users onto a shared record). */
export function principalOf(req: Request): string {
  const id = req.principal?.principalId;
  if (!id) throw new OpenwopError('sign_in_required', 'Sign in required.', 401, {});
  return id;
}

/**
 * Resolve the caller's ONE canonical durable user (ADR 0003). Anonymous callers
 * are refused.
 *
 * PERSONAL-TENANT MODEL (Firebase/OIDC — the prod config): the caller's home
 * tenant (`req.personalTenant`, a single-human `user:<hash(issuer:uid)>` that is
 * STABLE across the bearer / bound-cookie / session channels) keys ONE canonical
 * durable user. This is the fix for identity fragmentation (2026-06-12): the
 * prior principal-keyed resolution minted a SEPARATE user per channel
 * (`oidc:<sub>` bearer vs a bound `user:<userId>` cookie), so per-user data —
 * profile, pinned agents, notification prefs — split across them and a pin
 * written on one identity was invisible to reads on the other. Canonicalizing on
 * the home tenant collapses the channels and self-reconciles existing splits
 * (resolveCanonicalUserForTenant adopts the federated `oidc` record).
 *
 * SHARED / NON-PERSONAL TENANTS: many humans share one tenantId, so identity
 * MUST stay principal-keyed — a bound `req.userId` resolves directly (the keying
 * that makes `/me`, MFA, and the `/login` gate agree); an unbound durable
 * principal reconciles by `(tenantId, principalId)`. Never collapse these onto a
 * tenant key.
 */
export async function resolveCallerUser(req: Request): Promise<User> {
  requireSignedIn(req);
  // Single-human personal tenant → canonicalize across the caller's auth
  // channels onto one durable user (keyed by the stable home tenant, not the
  // volatile principal). Gated on the `user:` prefix so a shared/org tenant
  // never routes here (that would merge distinct humans).
  const homeTenant = req.personalTenant;
  if (homeTenant && homeTenant.startsWith('user:')) {
    const principalId = req.principal?.principalId ?? homeTenant;
    const source: UserSource =
      principalId.startsWith('oidc:') || principalId.startsWith('user:')
        ? 'oidc'
        : reconcilableSource(principalId) ?? 'oidc';
    // ADR 0622 D7 / USERS-20 — the bearer's IdP-VERIFIED email (the middleware
    // surfaces it ONLY under `email_verified: true`) rides into the canonical
    // fold, so an OIDC user's row carries an `'idp'` address without a bind
    // call. Cookie-only requests carry none and leave the row as it is.
    return resolveCanonicalUserForTenant({
      homeTenant, principalId, source,
      ...(req.oidcEmail ? { email: req.oidcEmail } : {}),
    });
  }
  if (req.userId) {
    const user = await getUser(req.userId);
    if (!user) throw new OpenwopError('sign_in_required', 'Session identity not found.', 401, {});
    return user;
  }
  const principalId = principalOf(req);
  // Reconcile ONLY a durable principal shape. `requireSignedIn` keys on the
  // tenant prefix (`anon:`) and can miss a transient `session:<sid>` carried on a
  // non-anon tenant — refuse it here by SHAPE so it never becomes a durable User.
  const source = reconcilableSource(principalId);
  if (!source) {
    throw new OpenwopError('sign_in_required', 'Sign in to access your account.', 401, {});
  }
  return upsertFromPrincipal({ tenantId: req.tenantId ?? 'default', principalId, source });
}

/**
 * ADR 0833 D9 — the durable user the caller ACTS AS, for "is this me?"
 * decisions (self-lockout, who asserted an email). `req.userId` alone missed
 * the API-key lane: an admin's own `owk_` key carried no `userId`, so it read
 * as "not self" — it could disable or erase its own issuer, and stamp the
 * trusted `'admin'` provenance on the admin's own email (S10). A key resolves
 * to its ISSUER (as a durable `userId`, through the same principal lookup the
 * approver seam uses, so an unbound `oidc:` issuer resolves too). Authority is
 * NOT decided here — a key holds scopes, never roles (D6 reads the raw
 * principal). `undefined` ⇒ no durable human behind the caller.
 */
export async function actingHumanUserId(req: Request): Promise<string | undefined> {
  if (req.userId) return req.userId;
  const auth = req.principal?.auth as { kind?: string; issuer?: string } | undefined;
  if (auth?.kind === 'api-key' && typeof auth.issuer === 'string' && auth.issuer) {
    const direct = await getUser(auth.issuer);
    if (direct) return direct.userId;
    return (await getUserByPrincipal(tenantOf(req), auth.issuer))?.userId;
  }
  try {
    return (await resolveCallerUser(req)).userId;
  } catch (err: unknown) {
    if (err instanceof OpenwopError && err.code === 'sign_in_required') return undefined;
    throw err;
  }
}

/**
 * ADR 0833 D6 — only an OWNER may disable, delete or sign out an OWNER.
 * `host:members:manage` is held by admins too, and the user lifecycle never
 * passed through the membership code's last-owner guard, so an admin could
 * lock the workspace's only owner out wherever the owner's durable row lives in
 * the shared tenant (SAML/SCIM tenants) — and so could a workflow run whose
 * acting user is an admin (S7, `UAUWF-8`).
 *
 * `actorSubject` is the RAW principal: an `apikey:` delegation holds scopes,
 * never roles (ADR 0797), so a key is never an owner here. Because self-lockout
 * already refuses the actor's own row, an owner is only ever acted on by
 * ANOTHER owner, so the last owner cannot be locked out this way. The one
 * residual — two owners disabling each other at the same instant — is filed
 * (`USERS2-CD-F7`). Fails closed: a store error throws.
 */
export async function assertMayActOnUser(
  tenantId: string,
  actorSubject: string | undefined,
  target: Pick<User, 'userId' | 'principalId'>,
  action: string,
): Promise<void> {
  const targetIsOwner =
    (await holdsOwnerRoleInTenant(tenantId, target.userId))
    || (await holdsOwnerRoleInTenant(tenantId, target.principalId));
  if (!targetIsOwner) return;
  if (actorSubject && (await holdsOwnerRoleInTenant(tenantId, actorSubject))) return;
  throw new OpenwopError(
    'forbidden',
    `Only an owner can ${action} an owner of this workspace.`,
    403,
    { code: 'owner_required', userId: target.userId },
  );
}
