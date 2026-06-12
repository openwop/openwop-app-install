/**
 * Analytics workflow surface (ADR 0014) — `ctx.features.analytics`, a THIN
 * read-only adapter over `analyticsService` (a run can read a metric to gate a
 * branch). Tenant from the run scope; org-scoped reads project out internal
 * columns. Read-only in v1 — `track` (write) + `conversion-forward` are Phase 2/3.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { summarize, listEvents } from './analyticsService.js';

const INTERNAL = new Set(['tenantId']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

export function buildAnalyticsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    summary: async (args) => ({ summary: await summarize(tenantId, str(args.orgId)) }),
    events: async (args) => {
      const evs = await listEvents(tenantId, str(args.orgId), 50);
      return { events: evs.map(project) };
    },
  };
}
