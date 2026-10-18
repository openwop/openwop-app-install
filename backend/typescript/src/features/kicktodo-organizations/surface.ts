/**
 * `ctx.features.kicktodo-organizations` (ADR 0428 P5) — read-only: the org's
 * curated catalog and the k-anonymous report. Writes stay on the governed
 * org-admin REST surface.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { libraryCatalog, orgReport } from './orgProgramService.js';
import { bindKicktodoSurface, type KicktodoSurfaceSpecs } from '../kicktodo-core/surfaceBinding.js';

/** ADR 0901 (DEC-1) — `report` is the org-manager read (`authorizeOrgScope(…,
 *  'host:org:manage')` at the route). The seam's `methodScopes` floor already
 *  applies that on the person lane; the binding adds the system-lane refusal
 *  (no host job reads a report) and the missing-org refusal. `catalog` is the
 *  org's curated library, membership-floored by the seam. */
export const KICKTODO_ORGANIZATIONS_SURFACE_SPECS = {
  catalog: { authority: 'none' },
  report: { authority: 'org-manage', personOnly: true },
} as const satisfies KicktodoSurfaceSpecs;

export function buildKicktodoOrganizationsSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return bindKicktodoSurface('kicktodo-organizations', scope, {
    catalog: async (args) => ({ catalog: await libraryCatalog(tenant, surfaceStr(args.orgId)) }),
    report: async (args) => ({ cells: await orgReport(tenant, surfaceStr(args.orgId)) }),
  }, KICKTODO_ORGANIZATIONS_SURFACE_SPECS);
}
