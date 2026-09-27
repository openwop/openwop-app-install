/**
 * feature.commerce.nodes (ADR 0177) — order + catalog ops over ctx.features.commerce.
 * role:"action" so outputs are recorded (replay/fork read the recorded order/list).
 */
function ensureCommerce(ctx) {
  const c = ctx.features && ctx.features.commerce;
  if (!c || typeof c.createOrder !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.commerce — the E-Commerce feature must be composed (ADR 0014)'), { code: 'host_capability_missing', capability: 'host.sample.commerce' });
  }
  return c;
}
function str(v) { return typeof v === 'string' ? v : ''; }
export async function createOrder(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  const out = await c.createOrder({ orgId: str(i.orgId), lines: Array.isArray(i.lines) ? i.lines : [], ...(str(i.contactId) ? { contactId: str(i.contactId) } : {}), ...(str(i.couponCode) ? { couponCode: str(i.couponCode) } : {}) });
  return { status: 'success', outputs: out };
}
export async function listProducts(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  const out = await c.listProducts({ orgId: str(i.orgId), ...(str(i.q) ? { q: str(i.q) } : {}) });
  return { status: 'success', outputs: out };
}
export const nodes = {
  'feature.commerce.nodes.create-order': createOrder,
  'feature.commerce.nodes.list-products': listProducts,
};

// ── Order-ops verbs (gap plan §5B B5) — thin adapters over ctx.features.commerce;
// the service applies audit + host events + the B3 approval thresholds. ──
export async function getOrder(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.getOrder({ orgId: str(i.orgId), orderId: str(i.orderId) }) };
}
export async function listOrders(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.listOrders({ orgId: str(i.orgId) }) };
}
export async function fulfillOrder(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.updateFulfillment({ orgId: str(i.orgId), orderId: str(i.orderId), fulfillmentStatus: str(i.fulfillmentStatus) }) };
}
export async function refundOrder(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.refundOrder({ orgId: str(i.orgId), orderId: str(i.orderId) }) };
}
export async function adjustInventory(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.adjustInventory({ orgId: str(i.orgId), productId: str(i.productId), inventory: typeof i.inventory === 'number' ? i.inventory : Number(i.inventory) }) };
}
export async function listCoupons(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.listCoupons({ orgId: str(i.orgId) }) };
}
export async function createCoupon(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.createCoupon({ orgId: str(i.orgId), code: str(i.code), type: str(i.type), value: typeof i.value === 'number' ? i.value : Number(i.value) }) };
}
nodes['feature.commerce.nodes.get-order'] = getOrder;
nodes['feature.commerce.nodes.list-orders'] = listOrders;
nodes['feature.commerce.nodes.fulfill-order'] = fulfillOrder;
nodes['feature.commerce.nodes.refund-order'] = refundOrder;
nodes['feature.commerce.nodes.adjust-inventory'] = adjustInventory;
nodes['feature.commerce.nodes.list-coupons'] = listCoupons;
nodes['feature.commerce.nodes.create-coupon'] = createCoupon;

// ── Quote + pricing verbs (gap plan §5C C3/C4) ──
export async function createQuote(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.createQuote({ orgId: str(i.orgId), lines: Array.isArray(i.lines) ? i.lines : [], ...(str(i.contactId) ? { contactId: str(i.contactId) } : {}), ...(str(i.companyId) ? { companyId: str(i.companyId) } : {}), ...(str(i.note) ? { note: str(i.note) } : {}) }) };
}
export async function getQuote(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.getQuote({ orgId: str(i.orgId), quoteId: str(i.quoteId) }) };
}
export async function listQuotes(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.listQuotes({ orgId: str(i.orgId) }) };
}
export async function sendQuote(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.sendQuote({ orgId: str(i.orgId), quoteId: str(i.quoteId) }) };
}
export async function resolvePriceNode(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.resolvePrice({ orgId: str(i.orgId), productId: str(i.productId), ...(str(i.variantId) ? { variantId: str(i.variantId) } : {}), ...(str(i.contactId) ? { contactId: str(i.contactId) } : {}), ...(str(i.companyId) ? { companyId: str(i.companyId) } : {}) }) };
}
nodes['feature.commerce.nodes.create-quote'] = createQuote;
nodes['feature.commerce.nodes.get-quote'] = getQuote;
nodes['feature.commerce.nodes.list-quotes'] = listQuotes;
nodes['feature.commerce.nodes.send-quote'] = sendQuote;
nodes['feature.commerce.nodes.resolve-price'] = resolvePriceNode;

// ── Catalog single-read (node-pack audit 2026-07-18) — parity with list-products. ──
export async function getProduct(ctx) {
  const c = ensureCommerce(ctx); const i = ctx.inputs ?? {};
  return { status: 'success', outputs: await c.getProduct({ orgId: str(i.orgId), productId: str(i.productId) }) };
}
nodes['feature.commerce.nodes.get-product'] = getProduct;
