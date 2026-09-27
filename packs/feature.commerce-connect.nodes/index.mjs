/**
 * feature.commerce-connect.nodes — seller-stats read node over the
 * `ctx.features['commerce-connect']` surface (ADR 0385 Phase 3). role:"action"
 * so the engine records the output and replay/fork read the recorded result.
 * READ-ONLY: onboarding/purchase/refund/approval are privileged REST actions,
 * never nodes. Pure-JS, Node-20 stdlib only.
 */

/** Resolve the Commerce Connect feature surface, or fail with the canonical error. */
function ensureCommerceConnect(ctx) {
  const cc = ctx.features && ctx.features['commerce-connect'];
  if (!cc || typeof cc.sellerStats !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['commerce-connect'] — the Commerce Connect feature must be composed (ADR 0385)"),
      { code: 'host_capability_missing', capability: 'host.sample.commerce-connect' },
    );
  }
  return cc;
}

export async function sellerStats(ctx) {
  const cc = ensureCommerceConnect(ctx);
  const out = await cc.sellerStats({});
  return {
    status: 'success',
    outputs: {
      seller: out.seller ?? null,
      // MPL-9 — the empty shape must match the real one field-for-field. The
      // agent reading this node used to get an overstated `paid` (it counted
      // refunded and disputed orders at full gross); the fallback shape here has
      // to carry the new fields too, or a degraded read silently reports a
      // DIFFERENT schema from a healthy one.
      sales: out.sales ?? {
        total: 0, paid: 0, refunded: 0, disputed: 0,
        grossMajorUnitsByCurrency: {}, feesMajorUnitsByCurrency: {},
        refundedMajorUnitsByCurrency: {}, netMajorUnitsByCurrency: {},
      },
      recentPayouts: Array.isArray(out.recentPayouts) ? out.recentPayouts : [],
    },
  };
}

export const nodes = {
  'feature.commerce-connect.nodes.seller-stats': sellerStats,
};

export default nodes;
