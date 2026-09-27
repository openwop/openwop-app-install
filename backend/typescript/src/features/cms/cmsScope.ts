/**
 * CMS org-scope guard with the reserved system-site allowance (ADR 0027 collapse).
 *
 * The public front page is a real `cmsService` page living in the reserved
 * `host-site` org under the `host:site` tenant (see `host/systemSite.ts`) — a
 * tenant no real principal can hold. Collapsing the standalone "Front page"
 * editor into the CMS Page Builder means a super admin edits that page through
 * the SAME `/cms/orgs/:orgId/*` routes as any org page — so the whole editor
 * (workflow, versions, experiments, localization, tags) works on it for free,
 * with NO parallel route family.
 *
 * The one thing that differs is AUTHORITY: the reserved org is host-level, not
 * tenant-scoped. `requireCmsScope` localizes that single exception here — when
 * (and ONLY when) the path org is the reserved system site, authorize on
 * `requireSuperadmin` instead of org membership. Every other org goes through
 * the untouched shared `requireOrgScope` guard, so no real tenant's isolation is
 * relaxed and `requireOrgScope` stays the single cross-tenant source of truth
 * (ADR 0027 explicitly rejected relaxing it broadly; this is a narrow, single
 * reserved-org allowance, not "cross-tenant CMS everywhere").
 *
 * Returns only the `tenantId`/`userId` the CMS handlers actually read, so the
 * synthetic host-authority context needs no fabricated `User` record.
 */
import type { Request } from 'express';
import type { Scope } from '../../host/accessControlService.js';
import type { User } from '../users/usersService.js';
import { OpenwopError } from '../../types.js';
import { requireOrgScope } from '../featureRoute.js';
import { isSuperadmin } from '../../host/superadmin.js';
import { ensureSystemSite, SYSTEM_SITE_ORG, SYSTEM_SITE_TENANT } from '../../host/systemSite.js';

/** The subset of caller identity every CMS handler reads (grep-verified).
 *
 *  ADR 0508 Phase 1 — `tenantId` is the tenant the handler was AUTHORIZED in and
 *  the one it must read/write in. It is a SEPARATE field from `user.tenantId`
 *  (the caller's home tenant) because the two genuinely differ on the system-site
 *  branch below, where authority is host-level and the data tenant is the reserved
 *  `SYSTEM_SITE_TENANT` rather than anything about the caller. */
export type CmsScopeCtx = { user: Pick<User, 'tenantId' | 'userId'>; orgId: string; tenantId: string };

export async function requireCmsScope(req: Request, scope: Scope): Promise<CmsScopeCtx> {
  if (req.params.orgId === SYSTEM_SITE_ORG) {
    // Host-level authority for the one reserved org — RBAC scope is N/A (a super
    // admin holds every authority over the system site). Non-superadmins get the
    // SAME 404 any foreign org yields, so the reserved org's editability stays
    // invisible in the authenticated CMS namespace (existence-hiding is uniform;
    // the published home page is separately world-readable via Publishing).
    if (!isSuperadmin(req)) {
      throw new OpenwopError('not_found', 'Organization not found.', 404, { orgId: SYSTEM_SITE_ORG });
    }
    // Idempotent + memoized; guarantees the org + seeded home page exist before
    // the first editor read (boot also seeds it).
    await ensureSystemSite();
    return {
      user: { tenantId: SYSTEM_SITE_TENANT, userId: req.principal?.principalId ?? 'superadmin' },
      orgId: SYSTEM_SITE_ORG,
      tenantId: SYSTEM_SITE_TENANT,
    };
  }
  return requireOrgScope(req, scope);
}
