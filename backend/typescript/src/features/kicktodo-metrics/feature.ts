/**
 * kicktodo-metrics (ADR 0432) — PRD §15 outcome metrics as computed-on-read
 * projections. No parallel read model, no rollup at rest.
 */

import type { BackendFeature } from '../types.js';
import { registerKicktodoMetricsRoutes } from './routes.js';
import { buildKicktodoMetricsSurface } from './surface.js';
import { registerKicktodoMetricsAgentTools } from './agentTools.js';

export const kicktodoMetricsFeature: BackendFeature = {
  id: 'kicktodo-metrics',
  registerRoutes: (deps) => {
    registerKicktodoMetricsRoutes(deps);
    // XCH-HOLE-1 — the Challenge Author's performance read. Registration is
    // process-wide; per-tenant toggle + manage authority are checked per call.
    registerKicktodoMetricsAgentTools();
  },
  toggleDefault: {
    id: 'kicktodo-metrics',
    label: 'KickTodo Metrics',
    description:
      'Outcome metrics (north star, activation, retention, recovery, factory quality) as counts-only computed-on-read projections with k≥5 withholding, plus sampled verifier FP/FN review.',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-metrics',
  },
  dependsOn: ['kicktodo-core', 'kicktodo-creator', 'goals'],
  requiredPacks: ['feature.kicktodo.nodes'],
  surface: { id: 'kicktodo-metrics', build: buildKicktodoMetricsSurface },
};
