/**
 * feature.analytics.nodes — Analytics read node over the `ctx.features.analytics`
 * surface (ADR 0014). role:"action" (reads the tenant event store), so the engine
 * records its output and replay/fork read the recorded result. Pure-JS, Node-20.
 */

function ensureAnalytics(ctx) {
  const a = ctx.features && ctx.features.analytics;
  if (!a || typeof a.summary !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.analytics — the Analytics feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.analytics' },
    );
  }
  return a;
}

export async function query(ctx) {
  const analytics = ensureAnalytics(ctx);
  const orgId = typeof (ctx.inputs ?? {}).orgId === 'string' ? ctx.inputs.orgId : '';
  const out = await analytics.summary({ orgId });
  return { status: 'success', outputs: { summary: out.summary ?? null } };
}

export async function events(ctx) {
  const analytics = ensureAnalytics(ctx);
  const orgId = typeof (ctx.inputs ?? {}).orgId === 'string' ? ctx.inputs.orgId : '';
  const out = await analytics.events({ orgId });
  return { status: 'success', outputs: { events: out.events ?? [] } };
}

export const nodes = {
  'feature.analytics.nodes.query': query,
  'feature.analytics.nodes.events': events,
};

export default nodes;
