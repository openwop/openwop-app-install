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
      const { user } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ rollup: await getUsageRollupWithCost(user.tenantId) });
    } catch (err) { next(err); }
  });
}
