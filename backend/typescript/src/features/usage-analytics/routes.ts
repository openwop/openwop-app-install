/**
 * Usage-analytics routes (ADR 0118 Phase 2) — admin, org-scoped read.
 * `GET /v1/host/openwop-app/usage/orgs/:orgId/rollup` — per-model token totals.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { getUsageRollupWithCost } from './usageRollupService.js';

const FEATURE = { toggleId: 'usage-analytics', label: 'Usage analytics' };

export function registerUsageAnalyticsRoutes(deps: RouteDeps): void {
  deps.app.get('/v1/host/openwop-app/usage/orgs/:orgId/rollup', async (req, res, next) => {
    try {
      // UAC-1 — this rollup is ADMIN-tier (FE `tier:'admin'`, `<AdminLayout>`). `workspace:read`
      // is a VIEWER scope, so a read-only member could read tenant-wide AI spend. Gate on
      // `host:members:manage` — the admin/owner-only management scope the FE's `isAdminCaller`
      // keys on and that `docs/routes.ts` reuses as the generic workspace-admin gate.
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'host:members:manage');
      res.json({ rollup: await getUsageRollupWithCost(tenantId) });
    } catch (err) { next(err); }
  });
}
