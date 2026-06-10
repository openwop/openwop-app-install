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

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';

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
    userId: `user:${randomUUID()}`,
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

/** Test-only: clear all users. */
export async function __resetUsersStore(): Promise<void> {
  await store.__clear();
}
