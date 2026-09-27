/**
 * Reference UCP-over-MCP merchant (ADR 0260 — validates the ADR 0258 `ucp.<op>` convention).
 *
 * A DEMO/dev fixture: a STATELESS projection over `commerceService` that speaks the UCP buyer's
 * assumed MCP tool convention (`ucp.discover` / `ucp.search` / `ucp.checkout` / `ucp.order-status`),
 * so the app's OWN UCP buyer can be validated end-to-end against a conformant merchant WITHOUT
 * waiting for a real external one. It holds NO store — the catalog + orders live in
 * `commerceService` under a fixed reference-merchant org (build ON orchestration, not a parallel
 * surface — the same class of artifact as the seller-side `ucpAdapter`, which also holds no state).
 *
 * MONEY-SAFETY (this fixture can NEVER move money):
 *  - `ucp.checkout` creates only a PENDING, UNPAID order via `commerceService.createOrder`.
 *  - it NEVER charges (no `markAsPaid` / Stripe / payment-intent), never fulfills, and IGNORES
 *    the `ap2_mandate` (demo data, not a verifiable credential — never treated as authorization).
 *  - the buyer's real money gates (fail-closed org cap + human approval + `placing` CAS) all run
 *    in `checkoutPurchase` BEFORE the merchant is ever called; this endpoint is downstream of them.
 *
 * CONVENTION NOTE — the SELLER-side UCP-MCP surface (ADR 0178, `ucpMcpTools.ts`) uses a DIFFERENT
 * convention (`ucp-catalog-search` / `ucp-place-order`, 2 ops, `content`-wrapped results). Converging
 * the buyer's `ucp.<op>` and the seller's `ucp-<op>` is a documented follow-on (ADR 0260 §deferred /
 * ADR 0258); this fixture pins the exact wire the seller would converge on.
 *
 * @see docs/adr/0260-reference-ucp-merchant.md, docs/adr/0258-ucp-buyer-mcp-transport.md
 */
import { OpenwopError } from '../../../types.js';
import { createOrder, createProduct, getOrder, listProducts, orderChargeTotal } from '../commerceService.js';
import { toStripeMinorUnits } from '../../billing/stripeApi.js';

/** The fixed namespace the reference merchant's catalog + orders live under (a demo tenant, so
 *  its secrets/data take the ephemeral/demo path — never a signed-in `user:`/`ws:` tenant). */
export const REF_MERCHANT_TENANT = 'demo-ucp-merchant';
export const REF_MERCHANT_ORG = 'ucp-ref-merchant';
/** The `reach:'mcp'` provider id the buyer addresses this merchant by (`merchantServerId`). */
export const REF_MERCHANT_PROVIDER = 'demo-ucp-merchant';
/** Seed-actor marker so the catalog is idempotent + a `clear()` only removes demo rows. */
export const REF_MERCHANT_ACTOR = 'demo:ucp-ref-merchant';

/** Static reference catalog (reference DATA, not a store — projected into `commerceService`). */
const REF_CATALOG: { name: string; description: string; price: number; currency: string; inventory: number }[] = [
  { name: 'Reference Widget', description: 'A demo catalog item served by the reference UCP merchant.', price: 12, currency: 'USD', inventory: 500 },
  { name: 'Reference Gadget', description: 'A second demo item, for multi-line carts.', price: 29, currency: 'USD', inventory: 250 },
  { name: 'Reference Sticker Pack', description: 'A low-cost item for small-order validation.', price: 4, currency: 'USD', inventory: 1000 },
];

/** Idempotently ensure the reference merchant's catalog exists (keyed by the seed actor + name).
 *  Returns the count newly created; a re-run is a no-op. Written through `commerceService` so the
 *  merchant has REAL product ids the buyer's checkout can order against. */
export async function ensureReferenceCatalog(): Promise<number> {
  const existing = await listProducts(REF_MERCHANT_TENANT, REF_MERCHANT_ORG);
  const have = new Set(existing.filter((p) => p.createdBy === REF_MERCHANT_ACTOR).map((p) => p.name));
  let created = 0;
  for (const item of REF_CATALOG) {
    if (have.has(item.name)) continue;
    await createProduct({ tenantId: REF_MERCHANT_TENANT, orgId: REF_MERCHANT_ORG, createdBy: REF_MERCHANT_ACTOR, type: 'physical', name: item.name, description: item.description, price: item.price, currency: item.currency, inventory: item.inventory });
    created++;
  }
  return created;
}

const DISCOVERY: Record<string, unknown> = {
  ucp: '1.0',
  vertical: 'shopping',
  merchant: { id: REF_MERCHANT_ORG, name: 'OpenWOP Reference Merchant' },
  mode: 'demo', // honest labeling — a reference fixture, never a real payee
  note: 'A demo reference merchant validating the ucp.<op> convention (ADR 0258/0260). No real payment moves.',
};

interface JsonRpcReq { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } }
type JsonRpcRes = { jsonrpc: '2.0'; id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

/**
 * Dispatch ONE UCP-over-MCP JSON-RPC `tools/call`, byte-compatible with the buyer's `merchantCall`
 * (ADR 0258): a BARE structured `result` (no `content` wrapper), the request `id` echoed. Transport-
 * agnostic (a route wraps it; a test drives it directly).
 */
export async function handleUcpMerchantRpc(body: unknown): Promise<JsonRpcRes> {
  const rpc = (body ?? {}) as JsonRpcReq;
  const id = rpc.id ?? null;
  const rpcErr = (code: number, message: string): JsonRpcRes => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (rpc.method !== 'tools/call') return rpcErr(-32601, `Method not found: ${String(rpc.method)}`);
  const tool = rpc.params?.name;
  const args = rpc.params?.arguments ?? {};
  try {
    if (tool === 'ucp.discover') return { jsonrpc: '2.0', id, result: DISCOVERY };
    if (tool === 'ucp.search') {
      const q = typeof args.q === 'string' ? args.q : undefined;
      const products = (await listProducts(REF_MERCHANT_TENANT, REF_MERCHANT_ORG, q))
        .map((p) => ({ productId: p.productId, name: p.name, price: p.price, currency: p.currency }));
      return { jsonrpc: '2.0', id, result: { products } };
    }
    if (tool === 'ucp.checkout') {
      const raw = Array.isArray(args.lines) ? args.lines : [];
      const lines = raw
        .map((l) => { const o = (l ?? {}) as { productId?: unknown; quantity?: unknown }; return { productId: String(o.productId ?? ''), quantity: Number(o.quantity ?? 0) }; })
        .filter((l) => l.productId && Number.isFinite(l.quantity) && l.quantity > 0);
      if (lines.length === 0) return rpcErr(-32602, 'checkout requires at least one { productId, quantity } line');
      // MONEY-SAFE: a PENDING, UNPAID order only. NEVER markAsPaid / charge; the `ap2_mandate` in
      // args is IGNORED (demo data, not a verifiable credential). The buyer already ran its money
      // gates before reaching here.
      const order = await createOrder({ tenantId: REF_MERCHANT_TENANT, orgId: REF_MERCHANT_ORG, createdBy: REF_MERCHANT_ACTOR, lines });
      // R2 UCP-P2-B2 — answer with what was ACTUALLY priced, so the buyer can reconcile
      // its mandate against the merchant's own total. Returning only an id made the
      // reconciliation untestable end-to-end and let a moved price go unnoticed.
      return { jsonrpc: '2.0', id, result: { orderId: order.orderId, totalMinor: toStripeMinorUnits(orderChargeTotal(order), order.currency), currency: order.currency, status: order.status } };
    }
    if (tool === 'ucp.order-status') {
      const order = await getOrder(REF_MERCHANT_TENANT, REF_MERCHANT_ORG, String(args.orderId ?? ''));
      return { jsonrpc: '2.0', id, result: { status: order?.status ?? 'unknown' } };
    }
    return rpcErr(-32601, `Unknown tool: ${String(tool)}`);
  } catch (err) {
    // A merchant-side failure (e.g. an unknown productId) surfaces as a JSON-RPC error → the buyer
    // classifies it DEFINITIVELY (`mcp_error` ⇒ 'failed', not the ambiguous 'unknown'). No internals leak.
    return rpcErr(-32000, err instanceof OpenwopError ? err.message : 'reference merchant error');
  }
}
