/**
 * ADR 0797 (CE-8) — `x-openwop-act-as` may only NARROW.
 *
 * The header exists so someone who administers a workspace can see it as one of
 * its members would ("view as viewer"). Every reader resolved authority for the
 * NAMED member and nothing else, so it was equally a way to become that member:
 * a Viewer naming the Owner's member id held the Owner's scopes (reproduced over
 * HTTP — a Viewer PATCHed itself to owner and DELETEd the owner).
 *
 * The rule, in one place: the access a request acts with is the named member's
 * access INTERSECTED with the caller's own. Naming someone with less than you
 * narrows; naming someone with more gives you nothing you did not already hold.
 *
 * Feature-free: routes in `routes/` and `features/` share these three functions
 * instead of each re-deriving "who is the caller".
 */
import type { Request } from 'express';
import {
  ACT_AS_HEADER,
  resolveEffectiveAccess,
  resolveTenantLevelScopes,
  type EffectiveAccess,
} from './accessControlService.js';
import { callerSubject, isOwnPersonalWorkspace, tenantOf } from './requestSubject.js';

const NONE: EffectiveAccess = { roles: [], scopes: [], basis: 'none' };

/** The member id the caller asked to act as, if any. */
export function actingMemberId(req: Request): string | undefined {
  const v = req.header(ACT_AS_HEADER);
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * The CALLER's own access in an org (no act-as). ADR 0015: the caller is the
 * implicit owner of their own personal workspace; otherwise authority is their
 * explicit membership in the org (ADR 0006 Phase 2), fail-closed.
 */
export async function callerOrgAccess(req: Request, orgId?: string): Promise<EffectiveAccess> {
  if (isOwnPersonalWorkspace(req)) return resolveEffectiveAccess(tenantOf(req));
  const subject = callerSubject(req);
  if (!subject) return NONE;
  return resolveEffectiveAccess(tenantOf(req), { subject, ...(orgId !== undefined ? { orgId } : {}) });
}

/**
 * The CALLER's own access at tenant level (workspace-scoped surfaces — ADR
 * 0731): the union across their memberships, plus the single-principal exit.
 * Roles are the caller's own member roles, or `owner` where the tenant is theirs
 * alone.
 */
export async function callerTenantAccess(req: Request): Promise<EffectiveAccess> {
  if (isOwnPersonalWorkspace(req)) return resolveEffectiveAccess(tenantOf(req));
  const subject = callerSubject(req);
  if (!subject) return NONE;
  const level = await resolveTenantLevelScopes(tenantOf(req), subject);
  if (level.basis === 'none') return NONE;
  if (level.basis === 'tenant-owner') return { roles: ['owner'], scopes: level.scopes, basis: 'tenant-owner' };
  const member = await resolveEffectiveAccess(tenantOf(req), { subject });
  return { roles: member.roles, scopes: level.scopes, basis: 'member' };
}

/** The named member's access, cut down to what the caller also holds. */
export function narrowToCaller(own: EffectiveAccess, acted: EffectiveAccess): EffectiveAccess {
  const callerIsOwner = own.roles.includes('owner');
  return {
    roles: acted.roles.filter((r) => callerIsOwner || own.roles.includes(r)),
    scopes: acted.scopes.filter((s) => own.scopes.includes(s)),
    basis: acted.basis,
    ...(acted.memberId !== undefined ? { memberId: acted.memberId } : {}),
  };
}

/**
 * The access this request acts with: `own`, or — under `x-openwop-act-as` —
 * the named member's access narrowed to `own`. A member id from another tenant
 * or org resolves to nothing, as before.
 */
export async function actingAccess(req: Request, own: EffectiveAccess, orgId?: string): Promise<EffectiveAccess> {
  const memberId = actingMemberId(req);
  if (memberId === undefined) return own;
  const acted = await resolveEffectiveAccess(tenantOf(req), { memberId, ...(orgId !== undefined ? { orgId } : {}) });
  return narrowToCaller(own, acted);
}
