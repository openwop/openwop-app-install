/**
 * Analytics workflow surface (ADR 0014) — `ctx.features.analytics`, a THIN
 * read-only adapter over `analyticsService` (a run can read a metric to gate a
 * branch). Tenant from the run scope; org-scoped reads project through
 * `toEventView` (ADR 0857 D2), the same allowlist the route uses. Read-only in v1 — `track` (write) + `conversion-forward` are Phase 2/3.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { requireString } from '../featureRoute.js';
import { summarizeForReport, listEvents, toEventView } from './analyticsService.js';

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
      // ADR 0857 D2 — the route's declared shape, from the ONE projector. This
      // used to strip only `tenantId`, so `visitorHash`/`clickIds`/`owx`/the
      // experiment stamp reached every run after ANL-15 removed them from HTTP.
      return { events: evs.map(toEventView) };
    },
  };
}
