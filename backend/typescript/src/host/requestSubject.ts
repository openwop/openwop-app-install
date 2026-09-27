/**
 * The caller's RBAC subject + tenant, derived from the request. Single source
 * of truth shared by the management surface (`routes/accessControl.ts`) and the
 * protocol surface (`host/protocolAuthorization.ts`) so the two never diverge —
 * a divergence here would make the same principal resolve to different authority
 * depending on which surface it hit (a security-relevant inconsistency, hence
 * one definition, not two copies). Extracted in the ADR 0006 Phase 3 follow-up.
 *
 * @see docs/adr/0006-rbac.md
 */

import type { Request } from 'express';

/** The caller's stable RBAC subject (ADR 0003): the bound `User.userId` when
 *  present, else the authenticated principal. Undefined only for a request with
 *  no principal at all (which fails closed everywhere it is used). */
export function callerSubject(req: Request): string | undefined {
  return (req as { userId?: string }).userId ?? req.principal?.principalId;
}

/** The caller's tenant (auth middleware sets `req.tenantId`; `'default'` for the
 *  single-principal demo / unauthenticated requests). With ADR 0015 this is the
 *  ACTIVE workspace — the personal tenant by default, or a shared `ws:<uuid>`
 *  the caller has switched into. */
export function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

/** The caller's OWN private tenant (ADR 0015) — set by the auth middleware
 *  (`anon:<sid>` / `user:<hash>`). When the active tenant equals this, the caller
 *  is the implicit OWNER of that workspace (a single-principal scope by
 *  construction); shared workspaces are strictly membership-derived. Undefined
 *  for unauthenticated / wildcard-bearer callers. */
export function personalTenantOf(req: Request): string | undefined {
  return (req as { personalTenant?: string }).personalTenant;
}

/**
 * True iff `tenantId` has the SHAPE of a personal workspace — a tenant that is
 * single-principal BY CONSTRUCTION, so "the caller's personal tenant is the
 * active tenant" really does mean "there is nobody else here to isolate from":
 *   - `user:<hash>` — one signed-in human's own workspace (ADR 0015; derived 1:1
 *     from the OIDC subject, `middleware/auth.ts` `tenantIdFromOidc`, and the
 *     `usersGuards.ts` canonical-user model relies on the same 1:1 fact)
 *   - `anon:<sid>`  — one ephemeral anonymous session's sandbox
 *
 * FALSE for everything else — a shared `ws:` workspace, `default`, and any
 * deployment-named tenant. USERS-19 (ADR 0617 D2 / ADR 0621): the SAML ACS mints
 * `personalTenant: OPENWOP_SAML_TENANT` (`routes/authSamlSso.ts`) — ONE
 * host-global tenant shared by EVERY SAML user — so "personal === active" was
 * TRUE for every plain SAML member and every implicit-owner short-circuit below
 * granted them owner authority (create/PATCH/disable/delete any user, …).
 * `personalTenant` is a claim the MINT SITE makes; this allowlist is what stops
 * a multi-human tenant from inheriting the single-principal assumption. An
 * unrecognised shape fails CLOSED (the `isSinglePrincipalTenant` discipline —
 * NOT reused here because that predicate also admits `default`, which is exactly
 * the shape a SAML deployment can mint).
 */
export function isPersonalTenantId(tenantId: string | undefined): tenantId is string {
  return tenantId !== undefined && (tenantId.startsWith('user:') || tenantId.startsWith('anon:'));
}

/** True iff the active tenant IS the caller's own personal workspace — the
 *  implicit-owner condition. Never true for a shared `ws:` workspace, and (USERS-19)
 *  never true unless the personal tenant has a personal SHAPE — see
 *  {@link isPersonalTenantId}: a session whose `personalTenant` is a multi-human
 *  tenant (the SAML host-global tenant, `default`) is NOT its implicit owner. */
export function isOwnPersonalWorkspace(req: Request): boolean {
  const personal = personalTenantOf(req);
  return isPersonalTenantId(personal) && tenantOf(req) === personal;
}

/** True iff the caller is a DURABLE signed-in account (a `user:`-prefixed
 *  personal tenant), not an ephemeral `anon:<sid>` sandbox session. ADR 0015 /
 *  ADR 0025 auto-provisioning — the personal workspace AND the personal board —
 *  is durable-only: anon sessions are throwaway and must never persist records
 *  (don't flood the store with abandoned anon orgs/boards). Single home for the
 *  rule so the workspace + board choke points can't drift. */
export function isDurableCaller(req: Request): boolean {
  const personal = personalTenantOf(req);
  return (personal?.startsWith('user:') ?? false) || typeof (req as { userId?: string }).userId === 'string';
}
