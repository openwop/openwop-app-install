/**
 * `ctx.features.kicktodo-metrics` (ADR 0432 P5) — read-only projections.
 * Nothing here is model-writable.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { activationMetrics, engagementMetrics, factoryMetrics } from './metricsService.js';
import { verifierQuality } from './verifierSampleService.js';

export function buildKicktodoMetricsSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    activation: async () => ({ metrics: await activationMetrics(tenant) }),
    engagement: async () => ({ metrics: await engagementMetrics(tenant) }),
    factory: async () => ({ metrics: await factoryMetrics(tenant) }),
    verifierQuality: async () => ({ quality: await verifierQuality(tenant) }),
  };
}
