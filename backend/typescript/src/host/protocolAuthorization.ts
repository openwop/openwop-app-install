/**
 * RFC 0049 — protocol-surface authorization (ADR 0006 Phase 3).
 *
 * Phase 1 seeded an explicit, `User.userId`-bound owner member at org creation;
 * Phase 2 made management authority membership-derived (a non-member resolves to
 * ZERO scopes, fail-closed). Phase 3 carries that same resolver onto the
 * PROTOCOL surface (runs/artifacts) and exposes the RFC 0049 §C decision seam —
 * and, only once that enforcement is real, advertises
 * `capabilities.authorization`.
 *
 * HONESTY GATE (the whole point of the phase split). Enforcement is OFF by
 * default and turns on with `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`:
 *   - OFF — `requireProtocolScope` is a no-op, the decision seam 404s, and
 *     discovery advertises `authorization.supported: false`. Every existing
 *     protocol caller (the conformance harness, Bearer principals with a tenant
 *     allow-list but no accessControl membership) is unaffected.
 *   - ON  — runs/artifacts routes fail-closed on the caller's membership-derived
 *     RFC 0049 scopes, the seam serves real decisions, and discovery advertises
 *     `authorization.supported: true` + `failClosed: true`. Only then does the
 *     conformance leg (`authorization-fail-closed.test.ts`) run non-vacuously.
 *
 * Advertising RFC 0049 the host doesn't enforce on the wire would be a false
 * authorization-oracle — exactly the posture ADR 0006 forbids. The capability is
 * advertised iff it is honored.
 *
 * @see docs/adr/0006-rbac.md (Phase 3)
 * @see RFCS/0049-rbac-scopes-and-authorization-decisions.md §C (fail-closed MUST)
 * @see spec/v1/host-sample-test-seams.md (`/v1/host/openwop-app/authorization/decide`)
 */

import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import {
  resolveSubjectScopesUnion,
  BUILT_IN_ROLE_IDS,
  BUILT_IN_ROLES,
  type Scope,
} from './accessControlService.js';
import { callerSubject, tenantOf, isOwnPersonalWorkspace } from './requestSubject.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.authorization');

/**
 * The single gate. When false, Phase 3 enforcement is dormant and the host does
 * NOT advertise `capabilities.authorization` — back-compat for every deployment
 * (and the conformance harness) that authenticates via Bearer/OIDC but has no
 * accessControl membership. Mirrors `isPhase3Enabled()` in discovery.ts.
 */
export function isAuthorizationEnforced(): boolean {
  return process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT === 'true';
}

/**
 * The `capabilities.authorization` advertisement (`capabilities.schema.json
 * §authorization`). `supported` tracks enforcement so the claim is never
 * dishonest; when enforced, `failClosed` is `const true` (RFC 0049 §C) and the
 * built-in role→scope catalog is published so a client can map a role to its
 * scope set without a round-trip.
 */
export function authorizationCapability(): {
  supported: boolean;
  failClosed?: true;
  roles?: Array<{ role: string; scopes: Scope[] }>;
} {
  if (!isAuthorizationEnforced()) return { supported: false };
  return {
    supported: true,
    failClosed: true,
    roles: BUILT_IN_ROLE_IDS.map((id) => ({ role: id, scopes: BUILT_IN_ROLES[id].scopes })),
  };
}

/**
 * RFC 0049 §C decision: does `principal` hold `action` (a scope) in `tenantId`?
 * FAIL-CLOSED — an absent/unseeded principal resolves to `basis: 'none'` with
 * zero scopes, so an unknown principal (or an unknown action that maps to no
 * scope) is denied. Authority is the UNION of the principal's scopes across all
 * its org memberships (the protocol surface is org-agnostic); a resolver error
 * resolves to zero scopes inside `resolveSubjectScopesUnion` (deny, never open).
 */
export async function decideProtocolAuthorization(
  tenantId: string,
  principal: string | undefined,
  action: string,
): Promise<{ allowed: boolean; basis: 'member' | 'none'; scopes: Scope[] }> {
  // No principal ⇒ nothing to resolve ⇒ deny.
  if (!principal) return { allowed: false, basis: 'none', scopes: [] };
  const { scopes, basis } = await resolveSubjectScopesUnion(tenantId, principal);
  return { allowed: scopes.includes(action as Scope), basis, scopes };
}

/**
 * Gate a PROTOCOL route (runs/artifacts) on an RFC 0049 scope. No-op when
 * enforcement is off (back-compat). When on, resolves the caller's own
 * membership-derived scopes and throws the canonical `forbidden` envelope
 * (auth.md §"Role-based authorization": "A denied REST action returns the
 * existing `forbidden` envelope") on a miss — fail-closed. An unauthenticated
 * caller has no subject and is denied.
 */
export async function requireProtocolScope(req: Request, scope: Scope): Promise<void> {
  if (!isAuthorizationEnforced()) return;
  // Wildcard bearer (OPENWOP_API_KEYS / admin token / conformance harness) is the
  // trusted full-access operator principal — the SAME escape hatch the
  // feature-toggle superadmin uses (routes/featureToggles.ts). Without it,
  // turning enforcement ON would 403 every API-key / conformance / curl caller
  // (they hold no accessControl membership), so enforcement could never be
  // enabled on a host that also serves bearer integrations (e.g. the demo).
  if (req.principal?.tenants?.includes('*')) return;
  // ADR 0015: the caller owns their OWN personal workspace (single-principal
  // scope) — full protocol scopes there without a seeded member. Shared `ws:`
  // workspaces stay strictly membership-derived (fail-closed) below.
  if (isOwnPersonalWorkspace(req)) return;
  const subject = callerSubject(req);
  const decision = await decideProtocolAuthorization(tenantOf(req), subject, scope);
  if (!decision.allowed) {
    // Observable, auditable denial (auth.md §"Decision event" — the SHOULD that
    // feeds the audit log). `subject` is an opaque RFC 0048 id, no PII.
    log.warn('authorization.denied', { scope, subject: subject ?? '(anonymous)', basis: decision.basis });
    throw new OpenwopError('forbidden', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
}
