/**
 * feature.analytics.nodes — Analytics read node over the `ctx.features.analytics`
 * surface (ADR 0014). role:"action" (reads the tenant event store). Pure-JS,
 * Node-20.
 *
 * WHERE THE ARGUMENTS COME FROM (`WF-ANL-1`, WORKFLOWS-ASSESSMENT 2026-08-18).
 * Both nodes used to read `ctx.inputs.orgId` and NOTHING else — but RFC 0013
 * **Path A**, which is the `…/workflows/from-chain` default, freezes a chain's
 * `{{params.orgId}}` into the node's **`config`**, not its inputs. So the org
 * scope never arrived: every shipped consumer called `summarize(tenantId, '')`,
 * which matches no rows, and the node returned that EMPTY summary as
 * `status:'success'` — an LLM then wrote a "Renewal Risk Digest" / "Board
 * Update" over nothing. The CRM sibling pack has always done the documented
 * merge (`packs/feature.crm.nodes/index.mjs` `args()`); analytics was the
 * outlier. Use `args(ctx)` — never `ctx.inputs` alone.
 *
 * INPUTS WIN ON CONFLICT: a DAG-forwarded value is a runtime fact, a config
 * value is an authoring-time default.
 *
 * NOTE ON REPLAY (`WF-ANL-3`, corrected here rather than left overstated): this
 * header used to claim "replay/fork read the recorded result". `role:"action"`
 * is NOT in the executor's `MANIFEST_FAST_PATH_SERVED` set, so these nodes
 * RE-EXECUTE live on `:fork` and a fork can report different figures than the
 * original run. That is acceptable for a read node whose output is advisory;
 * the claim is removed rather than the behaviour changed.
 */

/** Merge chain-authored config with DAG-forwarded inputs (inputs win on
 *  conflict) — the RFC 0013 Path A contract; see the file header. */
function args(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}

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
  const a = args(ctx);
  const orgId = typeof a.orgId === 'string' ? a.orgId : '';
  const out = await analytics.summary({ orgId });
  return { status: 'success', outputs: { summary: out.summary ?? null } };
}

export async function events(ctx) {
  const analytics = ensureAnalytics(ctx);
  const a = args(ctx);
  const orgId = typeof a.orgId === 'string' ? a.orgId : '';
  const out = await analytics.events({ orgId });
  return { status: 'success', outputs: { events: out.events ?? [] } };
}

export const nodes = {
  'feature.analytics.nodes.query': query,
  'feature.analytics.nodes.events': events,
};

export default nodes;
