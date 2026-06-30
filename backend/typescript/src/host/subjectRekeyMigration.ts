/**
 * ADR 0003 Phase 4d — one-shot subject re-key.
 *
 * A maintenance-gated, idempotent, transactional batch migration that rewrites
 * every legacy-form `OrgMember.subject` to its canonical `user:<userId>`.
 *
 * SCOPE IS NARROW + SAFE. This re-keys ONLY the RBAC subject
 * (`OrgMember.subject`) — NEVER run ownership. Runs are tenant-owned and carry
 * no subject stamp, so the ADR explicitly classifies this replay/fork-safe
 * (RFC 0048 §D): a pre-existing run's stamped owner is untouched.
 *
 * Resolution (never mint an identity):
 *   - Members already keyed `user:<...>` are canonical → left untouched.
 *   - A member with a LEGACY-form subject (`oidc:`/`saml:`/`scim:`/`session:`/
 *     `anon:`/`password:` …) is resolved via the EXISTING user resolver
 *     (`getUserByPrincipal(tenantId, legacySubject)`); if a durable `User`
 *     resolves AND its canonical `user:<userId>` differs from the current
 *     subject, the membership is re-keyed via the EXISTING `rekeyMemberSubject`
 *     primitive (which handles the deterministic personal-owner-member id
 *     re-derivation + the ≥1-owner safety net).
 *   - A legacy subject with NO resolvable durable user is SKIPPED — never
 *     invent an identity.
 *
 * Idempotent + safe to re-run: a second pass finds every membership already
 * `user:<...>` and re-keys nothing.
 */

import {
  listTenantMembers,
  rekeyMemberSubject,
} from './accessControlService.js';
import { getUserByPrincipal } from '../features/users/usersService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.subjectRekey');

const CANONICAL_PREFIX = 'user:';

export interface SubjectRekeyResult {
  /** Memberships examined (every member the tenant holds). */
  scanned: number;
  /** Memberships re-keyed from a legacy subject to `user:<userId>`. */
  rekeyed: number;
  /** Memberships left as-is: already canonical, no subject, or no resolvable
   *  durable user for a legacy subject (never invented). */
  skipped: number;
}

/** A subject is canonical when it is the opaque `user:<userId>` form; anything
 *  else (an auth-method string, an anon/session principal, or an absent
 *  subject) is a candidate for re-key. */
function isCanonicalSubject(subject: string | undefined): subject is string {
  return typeof subject === 'string' && subject.startsWith(CANONICAL_PREFIX);
}

/**
 * Re-key every legacy-form `OrgMember.subject` in `tenantId` to its canonical
 * `user:<userId>`. Returns a `{ scanned, rekeyed, skipped }` ledger.
 */
export async function rekeyLegacyMemberSubjects(tenantId: string): Promise<SubjectRekeyResult> {
  const tenantMembers = await listTenantMembers(tenantId);
  let rekeyed = 0;
  let skipped = 0;

  for (const member of tenantMembers) {
    // Already canonical (or no subject binding at all) → nothing to do.
    if (isCanonicalSubject(member.subject)) {
      skipped += 1;
      continue;
    }
    const legacySubject = member.subject;
    if (!legacySubject) {
      skipped += 1;
      continue;
    }

    // Resolve the canonical durable user for this legacy subject via the
    // EXISTING resolver. The legacy subject is the `User.principalId` join key.
    const user = await getUserByPrincipal(tenantId, legacySubject);
    if (!user) {
      // Never mint an identity for an unresolvable legacy subject — skip it.
      skipped += 1;
      continue;
    }

    // `User.userId` is ALREADY the canonical `user:<hash>` opaque subject
    // (mirrors the existing `rekeyMemberSubject(principalId, user.userId)`
    // caller on the OIDC-bind path).
    const canonical = user.userId;
    if (canonical === legacySubject) {
      // Defensive: resolved to the same string → no-op (idempotent).
      skipped += 1;
      continue;
    }

    const moved = await rekeyMemberSubject(legacySubject, canonical);
    if (moved > 0) {
      rekeyed += 1;
    } else {
      skipped += 1;
    }
  }

  log.info('subject_rekey_complete', { tenantId, scanned: tenantMembers.length, rekeyed, skipped });
  return { scanned: tenantMembers.length, rekeyed, skipped };
}
