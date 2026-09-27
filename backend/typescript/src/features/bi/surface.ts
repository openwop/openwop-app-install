/**
 * ADR 0417 P2 — `ctx.features.bi`: the workflow-facing surface the P3 node
 * pack wraps (list/run/catalog). Reads only; metric CRUD stays a human/admin
 * route concern. `getCatalog` is the ADR 0358 prompt-feed op — one projection
 * backs the agent tools AND the node prompts (zero drift by construction).
 */
import type { BundleScope, SurfaceFn } from '../../host/inMemorySurfaces.js';
import { AGGREGATES, METRIC_FILTER_OPS, TIME_BUCKETS } from './metricTypes.js';
import { listMetrics, runMetric } from './biService.js';
import { parseRunParams } from './routes.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The one prompt-facing catalog projection (SSoT: the metric defs + the
 *  closed vocabularies) — parity-tested against the tool/prompt text. */
export async function projectBiCatalog(tenantId: string): Promise<{
  metrics: Array<{ metricId: string; title: string; description?: string; entityType: string; aggregate: string; groupBy?: string; timeField?: string; system: boolean }>;
  vocab: { aggregates: readonly string[]; filterOps: readonly string[]; buckets: readonly string[] };
  promptMetricList: string;
}> {
  const metrics = await listMetrics(tenantId);
  const projected = metrics.map((m) => ({
    metricId: m.metricId,
    title: m.title,
    ...(m.description ? { description: m.description } : {}),
    entityType: m.entityType,
    aggregate: m.aggregate,
    ...(m.groupBy ? { groupBy: m.groupBy } : {}),
    ...(m.timeField ? { timeField: m.timeField } : {}),
    system: m.system === true,
  }));
  return {
    metrics: projected,
    vocab: { aggregates: AGGREGATES, filterOps: METRIC_FILTER_OPS, buckets: TIME_BUCKETS },
    promptMetricList: projected.map((m) => `${m.metricId} (${m.aggregate} over ${m.entityType})`).join(' · '),
  };
}

export function buildBiSurface(scope: BundleScope): Record<string, SurfaceFn> {
  const { tenantId } = scope;
  return {
    listMetrics: async () => ({ metrics: await listMetrics(tenantId) }),
    getCatalog: async () => ({ ...(await projectBiCatalog(tenantId)) }),
    runMetric: async (args) =>
      ({ result: await runMetric(tenantId, str(args.metricId), parseRunParams(str(args.orgId), args)) }),
  };
}
