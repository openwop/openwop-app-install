/**
 * `ctx.features.kicktodo-metrics` (ADR 0432 P5) — read-only projections.
 * Nothing here is model-writable.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { activationMetrics, engagementMetrics, factoryMetrics } from './metricsService.js';
import { verifierQuality } from './verifierSampleService.js';
import { bindKicktodoSurface, type KicktodoSurfaceSpecs } from '../kicktodo-core/surfaceBinding.js';

/** ADR 0901 (DEC-1) — every route here is `requireKicktodoManage`, so every
 *  method asks the SAME manage predicate; no host job reads metrics. */
export const KICKTODO_METRICS_SURFACE_SPECS = {
  activation: { authority: 'manage', personOnly: true },
  engagement: { authority: 'manage', personOnly: true },
  factory: { authority: 'manage', personOnly: true },
  verifierQuality: { authority: 'manage', personOnly: true },
} as const satisfies KicktodoSurfaceSpecs;

export function buildKicktodoMetricsSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return bindKicktodoSurface('kicktodo-metrics', scope, {
    activation: async () => ({ metrics: await activationMetrics(tenant) }),
    engagement: async () => ({ metrics: await engagementMetrics(tenant) }),
    factory: async () => ({ metrics: await factoryMetrics(tenant) }),
    verifierQuality: async () => ({ quality: await verifierQuality(tenant) }),
  }, KICKTODO_METRICS_SURFACE_SPECS);
}
