/**
 * `ctx.features.kicktodo-organizations` (ADR 0428 P5) — read-only: the org's
 * curated catalog and the k-anonymous report. Writes stay on the governed
 * org-admin REST surface.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { libraryCatalog, orgReport } from './orgProgramService.js';

export function buildKicktodoOrganizationsSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    catalog: async (args) => ({ catalog: await libraryCatalog(tenant, surfaceStr(args.orgId)) }),
    report: async (args) => ({ cells: await orgReport(tenant, surfaceStr(args.orgId)) }),
  };
}
