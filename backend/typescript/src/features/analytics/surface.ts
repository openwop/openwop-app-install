/**
 * Analytics workflow surface (ADR 0014) — `ctx.features.analytics`, a THIN
 * read-only adapter over `analyticsService` (a run can read a metric to gate a
 * branch). Tenant from the run scope; org-scoped reads project out internal
 * columns. Read-only in v1 — `track` (write) + `conversion-forward` are Phase 2/3.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { requireString } from '../featureRoute.js';
import { summarizeForReport, listEvents } from './analyticsService.js';

const INTERNAL = new Set(['tenantId']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

export function buildAnalyticsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // ANL-UX-4 R2 — `summarizeForReport`, NOT `summarize`: this all-time read
    // feeds workflow nodes whose output reaches a model (the exec-ops board
    // pack), so it must carry the SAME deployment-scoped `uniqueVisitorsSince`
    // the page and the chat tool do. Same single indexed read.
    summary: async (args) => ({ summary: (await summarizeForReport(tenantId, requireString(args.orgId, 'orgId'))).summary }),
    events: async (args) => {
      const evs = await listEvents(tenantId, requireString(args.orgId, 'orgId'), 50);
      return { events: evs.map(project) };
    },
  };
}
