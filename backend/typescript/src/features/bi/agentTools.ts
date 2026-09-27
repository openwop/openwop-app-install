/**
 * ADR 0417 P2 — the BI chat tools (ADR 0308 seam). `openwop:bi.list-metrics`
 * lets an agent discover the governed metric catalog; `openwop:bi.run-metric`
 * evaluates ONE metric with bounded params (never a filter AST — the ADR 0397
 * closed-world rule applied to analytics). Access mirrors the routes: the
 * toggle gate + tenant scoping; fails EMPTY without an acting user (system
 * runs have no human whose workspace should be measured). Tool text derives
 * from the SSoT vocabularies (parity-tested) — never a hand-copied list.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { AGGREGATES, TIME_BUCKETS } from './metricTypes.js';
import { projectBiCatalog } from './surface.js';
import { runMetric } from './biService.js';

export const BI_LIST_METRICS_TOOL_ID = 'openwop:bi.list-metrics';
export const BI_RUN_METRIC_TOOL_ID = 'openwop:bi.run-metric';

async function biEnabled(tenantId: string, userId?: string): Promise<boolean> {
  const assignment = await resolveOne('bi', { tenantId, ...(userId ? { userId } : {}) }).catch(() => null);
  return assignment?.enabled === true;
}

export function registerBiAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 review H4 — a CLOSED CATALOG OF LEGAL IDS whose sibling enforces
    // membership: `bi.run-metric` resolves `metricId` and returns a TYPED
    // not-found for anything not in this list. Its own description calls it
    // "the BI catalog". Structural twin of `app-builder.catalog` and
    // `slides.catalog`, both exempt since the list existed. Probed under
    // `lossy`: `['metric-0','metric-1','metric-2',{_elided:8},'metric-11']` —
    // the model then invents an id and the run fails in a way it cannot
    // diagnose, because what it was SHOWN was wrong.
    schemaCarrying: true,
    def: {
      name: BI_LIST_METRICS_TOOL_ID,
      description:
        'List the workspace\'s governed business metrics (the BI catalog): each entry has a metricId, title, '
        + `entity type, and aggregate (one of: ${AGGREGATES.join(', ')}). Read-only. `
        + 'Use a metricId with openwop:bi.run-metric to evaluate it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!scope.actingUserId || !(await biEnabled(scope.tenantId, scope.actingUserId))) {
        return { content: JSON.stringify({ metrics: [], note: 'BI metrics unavailable for this workspace/run' }) };
      }
      const catalog = await projectBiCatalog(scope.tenantId);
      return { content: JSON.stringify({ metrics: catalog.metrics }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: BI_RUN_METRIC_TOOL_ID,
      description:
        'Evaluate ONE governed business metric by metricId (from openwop:bi.list-metrics). '
        + 'Returns grouped numeric points ({key, value, n}). Bounded params only — there is no free-form query: '
        + `optional groupBy (a field of the metric's entity type), since/until (ISO dates over the metric's timeField), and bucket (one of: ${TIME_BUCKETS.join(', ')}).`,
      inputSchema: {
        type: 'object',
        properties: {
          metricId: { type: 'string', minLength: 1, description: 'The metric to run.' },
          orgId: { type: 'string', minLength: 1, description: 'The org whose rows to measure.' },
          groupBy: { type: 'string', description: 'Optional group-by field (validated against the entity type).' },
          since: { type: 'string', description: 'Optional ISO lower bound over the metric timeField.' },
          until: { type: 'string', description: 'Optional ISO upper bound over the metric timeField.' },
          bucket: { type: 'string', enum: [...TIME_BUCKETS], description: 'Optional time-series bucketing (needs a timeField; exclusive with groupBy).' },
        },
        required: ['metricId', 'orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId || !(await biEnabled(scope.tenantId, scope.actingUserId))) {
        return { content: JSON.stringify({ result: null, note: 'BI metrics unavailable for this workspace/run' }) };
      }
      try {
        const result = await runMetric(scope.tenantId, String(input.metricId ?? ''), {
          orgId: String(input.orgId ?? ''),
          ...(typeof input.groupBy === 'string' && input.groupBy ? { groupBy: input.groupBy } : {}),
          ...(typeof input.since === 'string' && input.since ? { since: input.since } : {}),
          ...(typeof input.until === 'string' && input.until ? { until: input.until } : {}),
          ...(typeof input.bucket === 'string' && input.bucket ? { bucket: input.bucket as (typeof TIME_BUCKETS)[number] } : {}),
        });
        return { content: JSON.stringify({ result }) };
      } catch (err) {
        // A typed validation/not-found error is USEFUL model feedback (the one
        // bounded error-fed repair) — surface the code+message, never a stack.
        const e = err as { code?: string; message?: string };
        return { content: JSON.stringify({ error: { code: e.code ?? 'error', message: e.message ?? 'metric run failed' } }), isError: true };
      }
    },
  });
}
