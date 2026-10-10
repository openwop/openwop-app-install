/**
 * Usage-analytics routes (ADR 0118 Phase 2) — admin, org-scoped read.
 * `GET /v1/host/openwop-app/usage/orgs/:orgId/rollup` — per-model token totals.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { getUsageRollupWithCost } from './usageRollupService.js';
import { listFeatureSpendForTenant } from '../../host/managedCredits.js';

/** ADR 0821 D4 — the window of managed (platform-paid) spend returned beside the
 *  BYOK rollup. Bounded so the read is a bounded slice of the tenant's rows. */
const MANAGED_WINDOW_DAYS = 30;

const FEATURE = { toggleId: 'usage-analytics', label: 'Usage analytics' };

export function registerUsageAnalyticsRoutes(deps: RouteDeps): void {
  deps.app.get('/host/openwop-app/usage/orgs/:orgId/rollup', async (req, res, next) => {
    try {
      // UAC-1 — this rollup is ADMIN-tier (FE `tier:'admin'`, `<AdminLayout>`). `workspace:read`
      // is a VIEWER scope, so a read-only member could read tenant-wide AI spend. Gate on
      // `host:members:manage` — the admin/owner-only management scope the FE's `isAdminCaller`
      // keys on and that `docs/routes.ts` reuses as the generic workspace-admin gate.
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'host:members:manage');
      // ADR 0821 D4 — the rollup below is BYOK-chat only (its sole writer is the
      // non-managed branches of `dispatchTurn`). Managed (platform-paid) spend now
      // has its own per-(day, feature) store; return the last 30 days of it beside
      // the BYOK totals so this dashboard finally sees the spend that matters.
      const since = new Date(Date.now() - (MANAGED_WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
      const managedByFeature = await listFeatureSpendForTenant(tenantId, since);
      res.json({ rollup: await getUsageRollupWithCost(tenantId), managedByFeature, managedWindowDays: MANAGED_WINDOW_DAYS });
    } catch (err) { next(err); }
  });
}
