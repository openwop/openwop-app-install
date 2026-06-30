/**
 * feature.marketplace.nodes — Marketplace search node over the
 * `ctx.features.marketplace` surface (ADR 0022 / ADR 0014). role:"action" so the
 * engine records its output and replay/fork read the recorded result. READ-ONLY:
 * it lists/searches the pack catalog and NEVER installs — install mutates
 * process-global state and is a privileged admin/host:* REST action, never a node.
 * Pure-JS, Node-20 stdlib only.
 */

/** Resolve the Marketplace feature surface, or fail with the canonical error. */
function ensureMarketplace(ctx) {
  const mkt = ctx.features && ctx.features.marketplace;
  if (!mkt || typeof mkt.search !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.marketplace — the Marketplace feature must be composed (ADR 0022)'),
      { code: 'host_capability_missing', capability: 'host.sample.marketplace' },
    );
  }
  return mkt;
}

export async function search(ctx) {
  const mkt = ensureMarketplace(ctx);
  const i = ctx.inputs ?? {};
  const query = typeof i.query === 'string' ? i.query : '';
  const out = await mkt.search({ query });
  const listings = Array.isArray(out.listings) ? out.listings : [];
  return { status: 'success', outputs: { listings, total: listings.length } };
}

export async function listings(ctx) {
  const mkt = ensureMarketplace(ctx);
  const out = await mkt.listings({});
  const list = Array.isArray(out.listings) ? out.listings : [];
  return { status: 'success', outputs: { listings: list, total: list.length } };
}

export const nodes = {
  'feature.marketplace.nodes.search': search,
  'feature.marketplace.nodes.listings': listings,
};

export default nodes;
