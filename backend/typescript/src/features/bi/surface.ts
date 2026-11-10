/**
 * ADR 0417 P2 — `ctx.features.bi`: the workflow-facing surface the P3 node
 * pack wraps (list/run/catalog). Reads only; metric CRUD stays a human/admin
 * route concern. `getCatalog` is the ADR 0358 prompt-feed op — one projection
 * backs the agent tools AND the node prompts (zero drift by construction).
 */
import type { BundleScope, SurfaceFn } from '../../host/inMemorySurfaces.js';
import { AGGREGATES, METRIC_FILTER_OPS, TIME_BUCKETS, type MetricCatalogEntry } from './metricTypes.js';
import { listMetrics, runMetric, projectCatalog } from './biService.js';
import { parseRunParams } from './routes.js';
import { OpenwopError } from '../../types.js';
import { assertRunScopeOrg } from '../../host/accessControlService.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The one prompt-facing catalog projection (SSoT: the metric defs + the
 *  closed vocabularies) — parity-tested against the tool/prompt text. ADR 1052: one
 *  org's catalog (D0), each entry the shared projection with its live `stale`
 *  verdict (D1/D9). */
export async function projectBiCatalog(tenantId: string, orgId: string): Promise<{
  metrics: MetricCatalogEntry[];
  vocab: { aggregates: readonly string[]; filterOps: readonly string[]; buckets: readonly string[] };
  promptMetricList: string;
}> {
  const projected = await projectCatalog(tenantId, await listMetrics(tenantId, orgId));
  return {
    metrics: projected,
    vocab: { aggregates: AGGREGATES, filterOps: METRIC_FILTER_OPS, buckets: TIME_BUCKETS },
    promptMetricList: projected.filter((m) => !m.stale).map((m) => `${m.metricId} (${m.aggregate} over ${m.entityType})`).join(' · '),
  };
}

/** ADR 0846 D3 / ADR 1052 D0 — every surface method names its org, and the run is
 *  limited to its starter's access there (`assertRunScopeOrg`, the MEDWF-2 pattern).
 *  An empty org is refused rather than read as "no org filter". An actorless run
 *  stays tenant-trusted — the standing `assertRunScopeOrg` contract. No surface
 *  method writes the catalog. */
async function runOrg(scope: BundleScope, orgId: string): Promise<string> {
  if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 422, { field: 'orgId' });
  await assertRunScopeOrg(scope, orgId, 'workspace:read');
  return orgId;
}

export function buildBiSurface(scope: BundleScope): Record<string, SurfaceFn> {
  const { tenantId } = scope;
  return {
    // ADR 1052 D9 — the projection, never raw definitions (no `createdBy` in run outputs).
    listMetrics: async (args) => ({ metrics: (await projectBiCatalog(tenantId, await runOrg(scope, str(args.orgId)))).metrics }),
    getCatalog: async (args) => ({ ...(await projectBiCatalog(tenantId, await runOrg(scope, str(args.orgId)))) }),
    runMetric: async (args) => {
      const orgId = await runOrg(scope, str(args.orgId));
      // grade-code M1 — a run caused by a person who is not its actor (a kanban Run, a
      // channel post) reads AS that person: `orgScopeSubject` narrows, never grants.
      return { result: await runMetric(tenantId, str(args.metricId), parseRunParams(orgId, args), scope.actingUserId ?? scope.orgScopeSubject) };
    },
  };
}
