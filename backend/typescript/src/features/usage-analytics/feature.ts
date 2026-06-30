/**
 * LLM usage analytics (ADR 0118, backlog B8). A per-model token/cost rollup over
 * recorded provider usage — the admin dashboard's data source. Read-only aggregation;
 * a `usage-analytics` toggle, off by default, per tenant.
 *
 * @see docs/adr/0118-llm-observability-otel.md
 */
import type { BackendFeature } from '../types.js';
import { registerUsageAnalyticsRoutes } from './routes.js';

export const usageAnalyticsFeature: BackendFeature = {
  id: 'usage-analytics',
  registerRoutes: (deps) => { registerUsageAnalyticsRoutes(deps); },
  toggleDefault: {
    id: 'usage-analytics',
    label: 'Usage analytics',
    description: 'Admin per-model token-usage rollup (B8) — aggregates recorded provider usage. Read-only. Default OFF, per tenant.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'usage-analytics',
  },
};
