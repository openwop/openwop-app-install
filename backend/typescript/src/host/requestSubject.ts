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

/** True iff the active tenant IS the caller's own personal workspace — the
 *  implicit-owner condition. Never true for a shared `ws:` workspace. */
export function isOwnPersonalWorkspace(req: Request): boolean {
  const personal = personalTenantOf(req);
  return personal !== undefined && tenantOf(req) === personal;
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
