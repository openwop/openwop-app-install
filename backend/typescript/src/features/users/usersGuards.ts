/**
 * Shared identity guards for the users feature (review finding #10 — these were
 * duplicated across routes.ts and mfaRoutes.ts).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { getUser, upsertFromPrincipal, type User } from './usersService.js';

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
 * Resolve the caller's ONE canonical durable user (ADR 0003). A session bound to
 * a durable account (`req.userId`, set after password login) resolves directly
 * by id — the single keying that makes `/me`, MFA, and the `/login` gate agree.
 * A signed-in caller without a bound userId (e.g. OIDC bearer, `oidc:<sub>`)
 * falls back to principal-keyed reconciliation. Anonymous callers are refused.
 */
export async function resolveCallerUser(req: Request): Promise<User> {
  requireSignedIn(req);
  if (req.userId) {
    const user = await getUser(req.userId);
    if (!user) throw new OpenwopError('sign_in_required', 'Session identity not found.', 401, {});
    return user;
  }
  return upsertFromPrincipal({
    tenantId: req.tenantId ?? 'default',
    principalId: principalOf(req),
    source: req.principal?.principalId?.startsWith('oidc:') ? 'oidc' : 'manual',
  });
}
