/**
 * Session authority seam (ADR 0621 § Boundaries audit) — the per-request
 * "is this durable-user session still allowed to exist?" read.
 *
 * `middleware/auth.ts` is core; `features/users/usersService.ts` is a feature,
 * and core must not import features (ADR 0001). So core DECLARES the seam here
 * and the users feature REGISTERS the read at feature init (the resolver-
 * registry pattern — precedent `host/approverResolution.ts`
 * `registerSubjectToUserIdResolver`, which the same feature already registers).
 *
 * NO PERMISSIVE DEFAULT (review SHOULD-5 — a fail-open default is a shape, not
 * a convenience): while nothing is registered, `resolveSessionSubject` THROWS a
 * typed `503 session_authority_unregistered`, so a user-tier session carrying a
 * `userId` is refused rather than silently trusted. `createApp` asserts
 * registration at boot; bare-middleware tests that mint no `userId`-bearing
 * cookie never reach this read (D4: anon sessions are skipped by tier).
 *
 * The read is a keyed POINT read (`getUser(userId)` = one `kvGet`, no cache —
 * D3), the same cost class as the per-request membership read ADR 0434 already
 * put on this path, and NOT the per-request upsert ADR 0015 §0 forbade.
 */

import { OpenwopError } from '../types.js';

/** What the middleware needs to decide, and nothing else — no PII. */
export interface SessionSubjectState {
  status: 'active' | 'disabled';
  /** The user's current session epoch (D2). A cookie stamped with an older
   *  epoch is `session_revoked`. Missing on legacy rows ⇒ the registrar
   *  normalises to 0. */
  sessionEpoch: number;
}

/** `null` ⇒ no durable row exists for `userId` (erased) — `account_erased`. */
export type SessionAuthority = (userId: string) => Promise<SessionSubjectState | null>;

/**
 * ADR 0621 D1 (rev. 2, review BLOCKER-1) — the UNBOUND-lane read. An
 * `oidc:<sub>` session in a `user:`-shaped personal tenant carries no `userId`,
 * but the durable row for that human still EXISTS (the ADR's "no row to
 * disable" premise was false: `resolveCallerUser` resolves it by home tenant),
 * so a disabled or erased account could keep a live, renewable session — and a
 * still-valid IdP token could re-mint one — through the promotion mint. This
 * read resolves the canonical row for a personal tenant WITHOUT ever creating
 * one (READ-ONLY by contract: the users feature's canonical fold has a creating
 * variant that MUST NOT be reached from here).
 *
 *   - `null`               → no durable row was ever bound for this human: the
 *                            ADR 0003 Phase 4 residual (nothing to disable).
 *   - `status: 'erased'`   → the canonical pointer names a row that no longer
 *                            exists — the erase tombstone → `account_erased`.
 *   - `status: 'disabled'` → `account_disabled`.
 *   - `status: 'active'`   → the middleware compares the cookie's epoch against
 *                            `sessionEpoch` and stamps it on the unbound mint,
 *                            so "sign out everywhere" covers this lane too.
 */
export type PersonalSubjectState =
  | (SessionSubjectState & { userId: string })
  | { status: 'erased'; userId: string; sessionEpoch: number };

export type PersonalTenantSessionAuthority = (
  personalTenant: string,
  subject: string,
) => Promise<PersonalSubjectState | null>;

let authority: SessionAuthority | null = null;
let personalTenantAuthority: PersonalTenantSessionAuthority | null = null;

/** Feature-init registration (the users feature). Re-registration replaces —
 *  tests use that to inject a throwing authority for the D6 witness. */
export function registerSessionAuthority(fn: SessionAuthority): void {
  authority = fn;
}

/** Feature-init registration of the unbound-lane read (same registrar). */
export function registerPersonalTenantSessionAuthority(fn: PersonalTenantSessionAuthority): void {
  personalTenantAuthority = fn;
}

/** Boot assertion hook (`createApp`) + test introspection. BOTH reads must be
 *  registered: a host with only the `userId` read would leave the unbound lane
 *  on the permissive default this seam exists to forbid. */
export function isSessionAuthorityRegistered(): boolean {
  return authority !== null && personalTenantAuthority !== null;
}

/**
 * The per-request read. Throws `session_authority_unregistered` (503, retry)
 * when no authority is registered — never returns a permissive default. A
 * registered authority that THROWS propagates as-is; the middleware maps it to
 * `session_authority_unavailable` (D6) so a storage blip fails THIS request
 * without evicting or granting.
 */
export async function resolveSessionSubject(userId: string): Promise<SessionSubjectState | null> {
  if (!authority) {
    throw new OpenwopError(
      'session_authority_unregistered',
      'The session authority is not registered on this host; durable-user sessions cannot be validated.',
      503,
      { retry: true },
    );
  }
  return authority(userId);
}

/**
 * The unbound-lane read (see {@link PersonalTenantSessionAuthority}). Same
 * posture as {@link resolveSessionSubject}: no permissive default, a throwing
 * authority propagates for the middleware's D6 mapping.
 */
export async function resolveSessionSubjectByPersonalTenant(
  personalTenant: string,
  subject: string,
): Promise<PersonalSubjectState | null> {
  if (!personalTenantAuthority) {
    throw new OpenwopError(
      'session_authority_unregistered',
      'The session authority is not registered on this host; personal-tenant sessions cannot be validated.',
      503,
      { retry: true },
    );
  }
  return personalTenantAuthority(personalTenant, subject);
}

/** Test-only: drop BOTH registrations so the unregistered posture is witnessable. */
export function __resetSessionAuthority(): void {
  authority = null;
  personalTenantAuthority = null;
}
