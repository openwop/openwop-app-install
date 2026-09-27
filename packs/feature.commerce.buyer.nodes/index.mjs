/**
 * feature.commerce.buyer.nodes (ADR 0188) — outbound UCP shopping over
 * ctx.features.commerce. The checkout verb is the app's highest-risk action:
 * the SERVICE enforces the org cap + the ALWAYS human approval; the pack's
 * mcpApproval:'always' metadata is chat-path defense-in-depth.
 */
function ensureCommerce(ctx) {
  const c = ctx.features && ctx.features.commerce;
  if (!c || typeof c.ucpBuildCart !== 'function') {
    throw Object.assign(new Error('host does not expose the UCP buyer surface — the E-Commerce feature must be composed (ADR 0188)'), { code: 'host_capability_missing', capability: 'host.sample.commerce' });
  }
  return c;
}
function str(v) { return typeof v === 'string' ? v : ''; }
// R2 UCP-P2-M7 — forward `merchantServerId` too. Three node DESCRIPTIONS advertise
// `{ merchantUrl | merchantServerId }` and the host surface accepts both, but this file
// forwarded only `merchantUrl` — so a chain author who followed the declared contract
// got "A valid merchant URL is required" naming a field they deliberately did not use,
// and the MCP transport was unreachable from every workflow chain.
function merchantRef(i) {
  return { merchantUrl: str(i.merchantUrl), ...(str(i.merchantServerId) ? { merchantServerId: str(i.merchantServerId) } : {}) };
}
export async function discover(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.ucpDiscover(merchantRef(i)) };
}
export async function searchCatalog(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.ucpSearchCatalog({ ...merchantRef(i), ...(str(i.q) ? { q: str(i.q) } : {}) }) };
}
export async function buildCart(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.ucpBuildCart({ orgId: str(i.orgId), ...merchantRef(i), intent: str(i.intent), maxAmountMinor: typeof i.maxAmountMinor === 'number' ? i.maxAmountMinor : Number(i.maxAmountMinor), ...(str(i.currency) ? { currency: str(i.currency) } : {}), lines: Array.isArray(i.lines) ? i.lines : [] }) };
}
export async function checkout(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.ucpCheckout({ orgId: str(i.orgId), purchaseId: str(i.purchaseId) }) };
}
export async function trackOrder(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.ucpTrack({ orgId: str(i.orgId), purchaseId: str(i.purchaseId) }) };
}
export async function listPurchases(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.ucpListPurchases({ orgId: str(i.orgId) }) };
}
export const nodes = {
  'feature.commerce.buyer.nodes.discover': discover,
  'feature.commerce.buyer.nodes.search-catalog': searchCatalog,
  'feature.commerce.buyer.nodes.build-cart': buildCart,
  'feature.commerce.buyer.nodes.checkout': checkout,
  'feature.commerce.buyer.nodes.track-order': trackOrder,
  'feature.commerce.buyer.nodes.list-purchases': listPurchases,
};
