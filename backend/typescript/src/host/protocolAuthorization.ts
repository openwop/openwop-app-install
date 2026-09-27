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
import { OpenwopError, type Principal } from '../types.js';
import {
  resolveEffectiveAccess,
  resolveSubjectScopesUnion,
  BUILT_IN_ROLE_IDS,
  BUILT_IN_ROLES,
  type Scope,
} from './accessControlService.js';
import { callerSubject, tenantOf, isOwnPersonalWorkspace } from './requestSubject.js';
import { createLogger } from '../observability/logger.js';
import { setBearerChallenge } from '../middleware/authChallenge.js';

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
 * ADR 0745 D2 — the protocol scopes this host ENFORCES: exactly the ones some
 * protocol route gates on. RFC 0200 §A.3 / `identity.md` §2.5 publish this list
 * (with `KEY_LANE_EXTENSION_SCOPES`, below) as the protected-resource metadata's
 * `scopes_supported`, which MUST list the scopes the host enforces — so it is not
 * the vocabulary (`PROTOCOL_SCOPES`, thirteen names) but the subset a caller can
 * actually be refused for.
 *
 * Kept honest in both directions: `requireProtocolScope` accepts ONLY these
 * (a new gate on any other scope is a compile error until it is listed), and
 * `test/adr0745-scopes.test.ts` scans the call sites so a listed scope nothing
 * gates on fails the build.
 *
 * ADR 0755 D1 adds `webhooks:manage` — the scope `rest-endpoints.md` names for
 * `/v1/webhooks` and `/v1/trigger-subscriptions`, gated there on both lanes.
 */
export const ENFORCED_PROTOCOL_SCOPES = ['runs:create', 'runs:read', 'runs:cancel', 'artifacts:read', 'approvals:respond', 'webhooks:manage'] as const satisfies readonly Scope[];
export type EnforcedProtocolScope = (typeof ENFORCED_PROTOCOL_SCOPES)[number];

/**
 * ADR 0755 D1 — the documented EXTENSION scopes (`auth.md` §"Documented extension
 * scopes") this host enforces on the KEY lane only: an `owk_` key that declares
 * scopes is refused a route whose scope it did not declare. They are not RFC 0049
 * RBAC vocabulary here (`PROTOCOL_SCOPES` is what a role or custom role can carry),
 * so membership authority on these routes stays each route's own check (prompt
 * workspace membership, the CMS tenant scopes). Listed in `scopes_supported`
 * because a caller CAN be refused for them — the same key-lane basis the core
 * five were advertised on before RFC 0049 enforcement is switched on.
 */
export const KEY_LANE_EXTENSION_SCOPES = ['runs:annotate', 'prompts:read', 'prompts:write', 'content:read', 'content:write'] as const;
export type KeyLaneExtensionScope = (typeof KEY_LANE_EXTENSION_SCOPES)[number];

/** RFC 0200 §A.3 `scopes_supported` — every scope some route refuses a caller for. */
export const SCOPES_SUPPORTED: readonly string[] = [...ENFORCED_PROTOCOL_SCOPES, ...KEY_LANE_EXTENSION_SCOPES];

/**
 * ADR 0745 D2 / ADR 0755 D2 — does a key's DECLARED delegation permit `scope`?
 * The ONE reading, shared with the MCP lane (`resolveMcpAuthority`) so the two
 * cannot disagree again (they did: `'*'` was all here and nothing there).
 * Empty `scopes` means UNDECLARED (types.ts `PrincipalAuth`), i.e. the issuer's
 * own authority; a declared `'*'` is read the same way — scopes are free-form at
 * mint (`apiKeyService.normalizeScopes`), and a key someone minted "all" must not
 * start 403ing on the day narrowing arrives.
 */
export function keyDeclarationPermits(declared: readonly string[], scope: string): boolean {
  return declared.length === 0 || declared.includes('*') || declared.includes(scope);
}

/**
 * ADR 0601 C4 — WHERE a non-wildcard credential's authority comes from, read
 * from its PROVENANCE (`Principal.auth`, stamped where the credential was
 * verified), never from its id string. The ONE classification for every lane
 * that resolves such a principal: the MCP tool gate (`resolveMcpAuthority`) and
 * the RFC 0103 §D content ops (`authorizeContent`). Each lane then asks its own
 * question of the answer (a tenant-wide scope union for MCP, the root-org scope
 * for content), because those questions genuinely differ. The SOURCE must not.
 *
 *  - `env-key` → `tenant-owner`: an `OPENWOP_API_KEYS` entry is the deployment
 *    operator's credential, "the tenant's own principal, in the tenant the config
 *    pinned it to". A member cannot mint one, so this is no escalation path. Its
 *    `bearer:<8>` id is NOT an RBAC subject (ADR 0601 C3).
 *  - `api-key` → the ISSUER (`ApiKeyRecord.createdBy`), with the key's declared
 *    scopes. A key is a delegation, so it can never hold more than its issuer
 *    holds NOW: the issuer's membership is re-read on every request, never
 *    captured at mint. An issuer who is removed or downgraded takes the key's
 *    authority down with them. A revoked key never gets here (401 at the auth
 *    boundary).
 *  - anything else → the caller's own subject (`fallbackSubject`).
 *
 * The wildcard (`*`) env key is deliberately NOT classified here: the lanes hold
 * different, pre-existing postures for it (ADR 0601 C4 "Not widened").
 */
export type CredentialAuthority =
  | { source: 'tenant-owner' }
  | { source: 'subject'; subject: string | undefined; declaredScopes?: readonly string[] };

export function credentialAuthority(principal: Principal, fallbackSubject: string | undefined): CredentialAuthority {
  const auth = principal.auth;
  if (auth?.kind === 'env-key') return { source: 'tenant-owner' };
  if (auth?.kind === 'api-key') return { source: 'subject', subject: auth.issuer, declaredScopes: auth.scopes };
  return { source: 'subject', subject: fallbackSubject };
}

/** The tenant-owner scope set: the subjectless `resolveEffectiveAccess` branch
 *  ("the caller is the tenant's own principal"), reached through that function
 *  rather than by writing an owner scope list. */
export async function tenantOwnerScopes(tenantId: string): Promise<readonly Scope[]> {
  return (await resolveEffectiveAccess(tenantId)).scopes;
}

/** The key-lane refusal: true when the request carries an `owk_` key whose declared scopes exclude `scope`. */
function keyNarrowingRefuses(req: Request, scope: string): boolean {
  const auth = req.principal?.auth;
  return auth?.kind === 'api-key' && !keyDeclarationPermits(auth.scopes, scope);
}

function refuseScope(req: Request, scope: string, basis: string, subject: string | undefined): never {
  log.warn('authorization.denied', { scope, subject: subject ?? '(anonymous)', basis });
  // RFC 0200 §B.1 — a 403 for insufficient scope carries
  // `Bearer error="insufficient_scope", scope="<every scope the operation
  // requires>", resource_metadata=…`, so a client learns WHAT to ask its
  // authorization server for. The body envelope is unchanged (`forbidden`,
  // §B.4); the header changes no status (§B.3) and is spec-legal on both majors
  // (§B.2). Only a SCOPE deny carries it — a resource-binding 403 (`run_forbidden`,
  // `id_tenant_mismatch`) MUST NOT, and those are thrown elsewhere.
  if (req.res) setBearerChallenge(req, req.res, { presented: true, error: 'insufficient_scope', scope: [scope] });
  throw new OpenwopError('forbidden', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
}

/**
 * ADR 0755 D1 — gate a route on a documented EXTENSION scope, key lane only.
 * Synchronous and membership-free by design (see `KEY_LANE_EXTENSION_SCOPES`).
 */
export function requireKeyLaneScope(req: Request, scope: KeyLaneExtensionScope): void {
  if (keyNarrowingRefuses(req, scope)) refuseScope(req, scope, 'key-scopes', req.principal?.principalId);
}

/**
 * ADR 0755 D3 — the non-throwing twin of `requireProtocolScope`, for PROJECTIONS:
 * a read that may return a field only a holder of `scope` may see (the interrupt
 * resume token needs `approvals:respond`, not the `runs:read` the read itself
 * needed). Same two checks, same order, no challenge and no log.
 */
export async function holdsProtocolScope(req: Request, scope: EnforcedProtocolScope): Promise<boolean> {
  if (keyNarrowingRefuses(req, scope)) return false;
  if (!isAuthorizationEnforced()) return true;
  if (req.principal?.tenants?.includes('*')) return true;
  if (isOwnPersonalWorkspace(req)) return true;
  return (await decideProtocolAuthorization(tenantOf(req), callerSubject(req), scope)).allowed;
}

/**
 * Gate a PROTOCOL route (runs/artifacts) on an RFC 0049 scope. Two checks: an
 * `owk_` key's DECLARED scopes, always (ADR 0745 D2); then, only when enforcement
 * is on (back-compat otherwise), membership — resolves the caller's own
 * membership-derived scopes and throws the canonical `forbidden` envelope
 * (auth.md §"Role-based authorization": "A denied REST action returns the
 * existing `forbidden` envelope") on a miss — fail-closed. An unauthenticated
 * caller has no subject and is denied. Both refusals carry the RFC 0200
 * `insufficient_scope` challenge (#4113's shape, set on `req.res` at the throw).
 */
export async function requireProtocolScope(req: Request, scope: EnforcedProtocolScope): Promise<void> {
  return requireProtocolScopeIn(req, tenantOf(req), scope);
}

/**
 * `requireProtocolScope` for an operation that runs in a tenant OTHER than the
 * caller's active one (ADR 0755 code-review M1: `/v1/webhooks?tenantId=<shared ws>`).
 * The membership decision is made in `tenantId`; the key-lane check is
 * tenant-independent. The personal-workspace escape applies only to the active
 * tenant, which is what `isOwnPersonalWorkspace` reads.
 */
export async function requireProtocolScopeIn(req: Request, tenantId: string, scope: EnforcedProtocolScope): Promise<void> {
  // ADR 0745 D2 — a self-service `owk_` key that DECLARES scopes is narrowed to
  // them, always: before the enforcement flag, before the wildcard and personal-
  // workspace escapes. A key narrowing its own delegation can only remove
  // authority, so there is no posture in which honouring it is unsafe.
  if (keyNarrowingRefuses(req, scope)) refuseScope(req, scope, 'key-scopes', req.principal?.principalId);
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
  if (tenantId === tenantOf(req) && isOwnPersonalWorkspace(req)) return;
  const subject = callerSubject(req);
  const decision = await decideProtocolAuthorization(tenantId, subject, scope);
  // Observable, auditable denial (auth.md §"Decision event" — the SHOULD that
  // feeds the audit log). `subject` is an opaque RFC 0048 id, no PII.
  if (!decision.allowed) refuseScope(req, scope, decision.basis, subject);
}
