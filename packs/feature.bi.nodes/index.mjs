/**
 * feature.bi.nodes — governed-metric reads over ctx.features.bi (ADR 0417 P3).
 * `run-metric` also emits the result as an `interactive.chart` artifact
 * envelope so the run/chat workbench renders the numbers (the detectTypedArtifact
 * lane); replay reads the recorded output. A weekly digest = a scheduled agent
 * chat (ADR 0125) calling these — zero new plumbing.
 */
function ensure(ctx, method) {
  const s = ctx.features && ctx.features.bi;
  if (!s || typeof s[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features.bi.${method} — the BI feature must be composed (ADR 0014)`),
      { code: 'host_capability_missing', capability: 'host.sample.bi' },
    );
  }
  return s;
}
function str(v) { return typeof v === 'string' ? v : ''; }

export async function listMetrics(ctx) {
  const bi = ensure(ctx, 'listMetrics');
  const out = await bi.listMetrics({});
  return { status: 'success', outputs: { metrics: out.metrics ?? [] } };
}

export async function getCatalog(ctx) {
  const bi = ensure(ctx, 'getCatalog');
  const out = await bi.getCatalog({});
  return { status: 'success', outputs: out };
}

export async function runMetric(ctx) {
  const bi = ensure(ctx, 'runMetric');
  const i = ctx.inputs ?? {};
  const out = await bi.runMetric({
    metricId: str(i.metricId),
    orgId: str(i.orgId),
    ...(str(i.groupBy) ? { groupBy: str(i.groupBy) } : {}),
    ...(str(i.since) ? { since: str(i.since) } : {}),
    ...(str(i.until) ? { until: str(i.until) } : {}),
    ...(str(i.bucket) ? { bucket: str(i.bucket) } : {}),
  });
  const result = out.result ?? { points: [] };
  const points = Array.isArray(result.points) ? result.points : [];
  // The chart envelope — picked up by detectTypedArtifact and rendered by the
  // registered interactive.chart renderer (bar for grouped, line for bucketed).
  const artifact = points.length
    ? {
        artifact: {
          artifactTypeId: 'interactive.chart',
          title: result.title ?? str(i.metricId),
          payload: {
            chartType: result.bucket ? 'line' : 'bar',
            data: {
              labels: points.map((p) => String(p.key)),
              datasets: [{ label: result.title ?? str(i.metricId), data: points.map((p) => Number(p.value)) }],
            },
          },
        },
      }
    : {};
  return { status: 'success', outputs: { result, ...artifact } };
}

export const nodes = {
  'feature.bi.nodes.list-metrics': listMetrics,
  'feature.bi.nodes.get-catalog': getCatalog,
  'feature.bi.nodes.run-metric': runMetric,
};
export default nodes;
