/**
 * Users store — durable identity records (ADR 0002, Phase 1).
 *
 * The foundational identity surface of the MyndHyve->openwop-app port. A `User`
 * is the durable, tenant-scoped record behind a principal: the existing auth
 * paths (oidcVerifier, cookie/session) produce a transient `req.principal`; this
 * gives that principal a record you can disable, list, and (in ADR 0006) assign
 * roles to. Backed by the same read-through, per-entity `DurableCollection` as
 * the CRM/roster surfaces — no schema migration.
 *
 * BOUNDARY (ADR 0002 §"principal/role boundary", finding H6): this captures raw
 * IdP `groups[]` onto the user at authentication time. Mapping groups -> roles
 * is RFC 0049 / RBAC and belongs to ADR 0006. NOTHING in this module decides
 * authorization — it only records identity.
 *
 * REPLAY/FORK (finding C4): a user's `userId` is STABLE across logins
 * (`upsertFromPrincipal` finds-or-creates by the `(tenantId, principalId)` join
 * key and never re-mints), so a run that stamped a creating principal resolves
 * to the same durable record on replay/fork even after the user is later
 * disabled — historical replay must not break when identity changes.
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';

// ADR 0077 P1 — a User's email + display name are personal data (the `userId`
// itself is an opaque, non-PII principal id per RFC 0048, so it is NOT listed).
declarePiiFields('users.user', ['email', 'displayName']);

/** Account lifecycle state. `disabled` is FAIL-CLOSED (finding H5): a disabled
 *  user is denied; there is no fail-open path. */
export type UserStatus = 'active' | 'disabled';

/** Which auth method last minted/updated the record (provenance, not a role). */
export type UserSource = 'oidc' | 'password' | 'saml' | 'scim' | 'manual';
export const USER_SOURCES: readonly UserSource[] = ['oidc', 'password', 'saml', 'scim', 'manual'];

export interface User {
  userId: string;
  tenantId: string;
  /** The auth join key — `req.principal.principalId` (e.g. `oidc:<sub>`, later a
   *  SAML NameID or SCIM userName). Unique within a tenant. */
  principalId: string;
  email?: string;
  displayName?: string;
  /** Raw IdP group membership captured at auth time. Group->role mapping is
   *  ADR 0006 (RBAC) — this is just what the IdP asserted, verbatim. */
  groups: string[];
  source: UserSource;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

const store = new DurableCollection<User>('users:user', (u) => u.userId);

/** Tenant's users, newest first. */
export async function listUsers(tenantId: string): Promise<User[]> {
  const all = await store.list();
  return all.filter((u) => u.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getUser(userId: string): Promise<User | null> {
  return store.get(userId);
}

/** Look a user up by the auth join key `(tenantId, principalId)`. */
export async function getUserByPrincipal(tenantId: string, principalId: string): Promise<User | null> {
  const all = await store.list();
  return all.find((u) => u.tenantId === tenantId && u.principalId === principalId) ?? null;
}

/** Manually create a user (admin path). For auth-driven creation use
 *  `upsertFromPrincipal`, which is idempotent across logins. */
/** DETERMINISTIC durable id for a `(tenantId, principalId)` — so concurrent
 *  first-access reconciliations converge on ONE row (same key, last-writer-wins)
 *  instead of racing the unindexed get-then-put to two `randomUUID()` records.
 *  Same hazard + fix as `personalOwnerMemberId` (ADR 0015 Phase 2). Fixed at
 *  creation and never re-derived — account-linking adds `linkedIds`, it does not
 *  re-key the `userId` — so coupling the id to the *primary* principal is safe. */
function userIdFor(tenantId: string, principalId: string): string {
  return `user:${createHash('sha256').update(`${tenantId}:${principalId}`).digest('hex').slice(0, 32)}`;
}

export async function createUser(input: {
  tenantId: string;
  principalId: string;
  email?: string;
  displayName?: string;
  groups?: string[];
  source?: UserSource;
  status?: UserStatus;
}): Promise<User> {
  const existing = await getUserByPrincipal(input.tenantId, input.principalId);
  if (existing) return existing; // idempotent: never two records per principal
  const now = new Date().toISOString();
  const user: User = {
    userId: userIdFor(input.tenantId, input.principalId),
    tenantId: input.tenantId,
    principalId: input.principalId,
    groups: input.groups ?? [],
    source: input.source ?? 'manual',
    status: input.status ?? 'active',
    createdAt: now,
    updatedAt: now,
    ...(input.email ? { email: input.email } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  };
  await store.put(user);
  return user;
}

/**
 * Find-or-create the durable record for an authenticated principal — the
 * reconciliation seam the auth paths call so a transient `req.principal` becomes
 * a durable `User` (ADR 0002 Phase 1). Idempotent and STABLE: the `userId`
 * persists across logins (finding C4); subsequent logins refresh `email` /
 * `displayName` / `groups` / `source` but never re-mint the id and never flip a
 * `disabled` status back to active (only the explicit lifecycle call does that —
 * fail-closed, finding H5).
 */
export async function upsertFromPrincipal(input: {
  tenantId: string;
  principalId: string;
  email?: string;
  displayName?: string;
  groups?: string[];
  source?: UserSource;
}): Promise<User> {
  const existing = await getUserByPrincipal(input.tenantId, input.principalId);
  if (!existing) {
    return createUser({ ...input, source: input.source ?? 'oidc' });
  }
  const next: User = { ...existing, updatedAt: new Date().toISOString() };
  if (input.email !== undefined) next.email = input.email;
  if (input.displayName !== undefined) next.displayName = input.displayName;
  if (input.groups !== undefined) next.groups = input.groups;
  if (input.source !== undefined) next.source = input.source;
  // NOTE: status is intentionally NOT touched here — a disabled user staying
  // signed in does not silently re-activate (fail-closed).
  await store.put(next);
  return next;
}

/** Update mutable profile fields (admin/self path). Identity keys
 *  (`userId`/`principalId`/`tenantId`) and `status` are not editable here. */
export async function updateUser(
  userId: string,
  patch: { email?: string | null; displayName?: string | null; groups?: string[] },
): Promise<User | null> {
  const existing = await store.get(userId);
  if (!existing) return null;
  const next: User = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.groups !== undefined) next.groups = patch.groups;
  if (patch.email !== undefined) {
    if (patch.email === null || patch.email === '') delete next.email;
    else next.email = patch.email;
  }
  if (patch.displayName !== undefined) {
    if (patch.displayName === null || patch.displayName === '') delete next.displayName;
    else next.displayName = patch.displayName;
  }
  await store.put(next);
  return next;
}

/** The account lifecycle (disable/enable). Disabling is the fail-closed control
 *  (finding H5): a disabled user is denied at the resolver. */
export async function setUserStatus(userId: string, status: UserStatus): Promise<User | null> {
  const existing = await store.get(userId);
  if (!existing) return null;
  const next: User = { ...existing, status, updatedAt: new Date().toISOString() };
  await store.put(next);
  return next;
}

export async function deleteUser(userId: string): Promise<boolean> {
  return store.delete(userId);
}

/**
 * Fail-closed activity check (finding H5): true ONLY when a durable record
 * exists for the principal AND its status is `active`. An unknown principal or a
 * disabled one is denied. (Phase 1 exposes this for the feature's own routes;
 * cross-surface enforcement is wired in ADR 0006 with RBAC.)
 */
export async function isActiveUser(tenantId: string, principalId: string): Promise<boolean> {
  const user = await getUserByPrincipal(tenantId, principalId);
  return user?.status === 'active';
}

// ── Canonical identity per personal tenant (one human → one durable user) ──
//
// In the personal-tenant model (Firebase/OIDC: every human owns a single
// `user:<hash(issuer:uid)>` tenant), the SAME human reaches the host over more
// than one auth channel — an `oidc:<sub>` bearer, a bound user-tier cookie
// (`user:<userId>`), an unbound `session:<sid>`. `upsertFromPrincipal` keys the
// durable user on the *principal*, so those channels mint/resolve DIFFERENT
// users, and per-user data (profile, pinned agents, notification prefs) silently
// fragments across them (caught 2026-06-12: a pinned agent written on the oidc
// identity was invisible to reads on the bound-cookie identity).
//
// The fix: ONE canonical durable user per personal tenant, resolved by the
// stable tenant key (not the volatile principal). A pointer row maps the home
// tenant → the chosen userId. First resolution ADOPTS a pre-existing
// principal-keyed record if one exists (legacy / pre-canonical logins),
// preferring an `oidc` record (the federated identity) so two split rows
// converge on the one that holds the user's data — no data migration needed.
//
// SAFETY: only valid for a SINGLE-HUMAN tenant (`user:` personal tenants, which
// derive 1:1 from the OIDC subject). A shared/org tenant has many humans on one
// tenantId — callers MUST NOT route it here (resolveCallerUser gates on the
// `user:` prefix), or distinct humans would collapse onto one record.
interface CanonicalUserRow {
  homeTenant: string;
  userId: string;
}
const canonicalByTenant = new DurableCollection<CanonicalUserRow>('users:canonical', (r) => r.homeTenant);

export async function resolveCanonicalUserForTenant(input: {
  homeTenant: string;
  principalId: string;
  source: UserSource;
  email?: string;
  displayName?: string;
}): Promise<User> {
  const ptr = await canonicalByTenant.get(input.homeTenant);
  if (ptr) {
    const u = await getUser(ptr.userId);
    if (u) return u; // hot path: a point lookup, no scan
    // Pointer dangling (the user was deleted) — fall through and re-pick.
  }
  // Adopt a pre-existing record for this human, if any (the legacy split rows).
  // Prefer the federated `oidc` identity, then the oldest as a stable tiebreak.
  const existing = (await listUsers(input.homeTenant)).slice().sort((a, b) => {
    if ((a.source === 'oidc') !== (b.source === 'oidc')) return a.source === 'oidc' ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const chosen =
    existing[0] ??
    (await createUser({
      tenantId: input.homeTenant,
      principalId: input.principalId,
      source: input.source,
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    }));
  await canonicalByTenant.put({ homeTenant: input.homeTenant, userId: chosen.userId });
  return chosen;
}

/** Test-only: clear all users. */
export async function __resetUsersStore(): Promise<void> {
  await store.__clear();
  await canonicalByTenant.__clear();
}
