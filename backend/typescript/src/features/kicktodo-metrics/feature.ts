/**
 * kicktodo-metrics (ADR 0432) — PRD §15 outcome metrics as computed-on-read
 * projections. No parallel read model, no rollup at rest.
 */

import type { BackendFeature } from '../types.js';
import { registerKicktodoMetricsRoutes } from './routes.js';
import { buildKicktodoMetricsSurface } from './surface.js';

export const kicktodoMetricsFeature: BackendFeature = {
  id: 'kicktodo-metrics',
  registerRoutes: registerKicktodoMetricsRoutes,
  toggleDefault: {
    id: 'kicktodo-metrics',
    label: 'KickTodo Metrics',
    description:
      'PRD §15 outcome metrics (north star, activation, retention, recovery, factory quality) as counts-only computed-on-read projections with k≥5 withholding, plus sampled verifier FP/FN review (ADR 0432).',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-metrics',
  },
  dependsOn: ['kicktodo-core', 'kicktodo-creator', 'goals'],
  requiredPacks: [{ name: 'feature.kicktodo.nodes', version: '1.30.0' }],
  surface: { id: 'kicktodo-metrics', build: buildKicktodoMetricsSurface },
};
