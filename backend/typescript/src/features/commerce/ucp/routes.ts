/**
 * UCP server routes (ADR 0178 Phase 1) — a UCP-conformant Shopping surface that PROJECTS
 * commerce so external AI agents can discover a catalog, build a cart, check out, and track
 * orders against an openwop-app merchant. The merchant stays Merchant of Record.
 *
 * Two surfaces:
 *  - PUBLIC (agents) under `/v1/host/openwop-app/commerce/ucp/orgs/:orgId/*` — tenant from
 *    the RESOURCE (the org), gated by the `commerce-ucp` toggle for that tenant; catalog
 *    reads are open, cart/checkout writes need an OAuth bearer + scope. Never a new store —
 *    every write flows through `commerceService`.
 *  - ADMIN (merchant) under the authed commerce BASE `.../commerce/orgs/:orgId/ucp/*` —
 *    provision/list/revoke the UCP agent clients (workspace:write / :read).
 *
 * @see docs/adr/0178-ucp-universal-commerce-protocol.md
 */
import type { Request } from 'express';
import { OpenwopError } from '../../../types.js';
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireFeatureEnabled, publicBaseUrl, requireString } from '../../featureRoute.js';
import type { Scope } from '../../../host/accessControlService.js';
import type { User } from '../../users/usersService.js';
import { getOrg } from '../../../host/accessControlService.js';
import { resolveOne } from '../../../host/featureToggles/service.js';
import { listProducts, getProduct, getCart, setCartItem, clearCart, checkoutCart, getOrder, markAsPaid, cancelOrder } from '../commerceService.js';
import type { Product } from '../commerceService.js';
import { resolveAp2Payment } from './ap2.js';
import {
  provisionClient, listClients, deleteClient, issueToken, verifyToken,
  type UcpScope, type UcpPrincipal,
} from './ucpClientStore.js';
import { toUcpCatalogItem, toUcpCart, toUcpOrder, ucpDiscovery, oauthMetadata } from './ucpAdapter.js';

const UCP_TOGGLE = 'commerce-ucp';
const ADMIN_BASE = '/v1/host/openwop-app/commerce/orgs/:orgId/ucp';
const UCP_BASE = '/v1/host/openwop-app/commerce/ucp/orgs/:orgId';

/** Resolve the merchant org from the URL (tenant from the resource, never the request) and
 *  enforce the `commerce-ucp` toggle FOR THAT TENANT. Unknown org OR disabled surface ⇒ a
 *  uniform 404 (no existence leak — the public-surface discipline). */
async function resolveMerchant(orgId: string): Promise<{ tenantId: string; orgId: string; merchantName: string }> {
  const org = await getOrg(orgId);
  if (!org) throw new OpenwopError('not_found', 'Merchant not found.', 404, {});
  const assignment = await resolveOne(UCP_TOGGLE, { tenantId: org.tenantId });
  if (!assignment || !assignment.enabled) throw new OpenwopError('not_found', 'Merchant not found.', 404, {});
  return { tenantId: org.tenantId, orgId, merchantName: org.name };
}

/** Authenticate a UCP bearer for the org and require a scope, else 401/403 (fail-closed). */
async function requireUcpScope(req: Request, tenantId: string, orgId: string, scope: UcpScope): Promise<UcpPrincipal> {
  const principal = await verifyToken(tenantId, orgId, req.get('authorization') ?? undefined, Date.now());
  if (!principal) throw new OpenwopError('unauthenticated', 'A valid UCP bearer token is required.', 401, {});
  if (!principal.scopes.includes(scope)) throw new OpenwopError('forbidden', `Missing required scope: ${scope}`, 403, { scope });
  return principal;
}

export function registerCommerceUcpRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // GC-5 / ADR 0508 — carry the gate's ACTIVE-tenant field. `authorizeOrgScope`
  // authorizes against the ACTIVE workspace tenant (`tenantOf(req)`) and returns it
  // as `tenantId`; reading `user.tenantId` instead is the caller's HOME tenant, so
  // inside a shared `ws:` workspace the client would be filed under the member's
  // private partition. Handlers must key off `ctx.tenantId` (the gate's active tenant).
  interface Ctx { user: User; orgId: string; tenantId: string }
  // Admin client-provisioning is a UCP surface, so gate it on `commerce-ucp` (managing UCP
  // agent clients while the UCP surface is off would be inconsistent — the FE hides it, so
  // the API should too). Scopes still come from the commerce org-scope authz.
  const authz = async (req: Request, scope: Scope): Promise<Ctx> => {
    const ctx = await authorizeOrgScope(req, { toggleId: 'commerce', label: 'E-Commerce' }, scope);
    await requireFeatureEnabled(req, UCP_TOGGLE, 'Universal Commerce Protocol (UCP)');
    return ctx;
  };

  // ── ADMIN (authed) — UCP agent client provisioning ──────────────────────────
  app.get(`${ADMIN_BASE}/clients`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ clients: await listClients(ctx.tenantId, ctx.orgId) }); } catch (err) { next(err); }
  });
  app.post(`${ADMIN_BASE}/clients`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { client, clientSecret } = await provisionClient({ tenantId: ctx.tenantId, orgId: ctx.orgId, name: b.name, scopes: b.scopes });
      // The secret is returned ONCE (never stored in the clear) — the API-key discipline.
      res.status(201).json({ ...client, clientSecret });
    } catch (err) { next(err); }
  });
  app.delete(`${ADMIN_BASE}/clients/:clientId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const ok = await deleteClient(ctx.tenantId, ctx.orgId, req.params.clientId); if (!ok) throw new OpenwopError('not_found', 'Client not found.', 404, {}); res.status(204).end(); } catch (err) { next(err); }
  });

  // ── PUBLIC discovery ────────────────────────────────────────────────────────
  app.get(`${UCP_BASE}/.well-known/ucp`, async (req, res, next) => {
    try { const m = await resolveMerchant(req.params.orgId); res.json(ucpDiscovery({ baseUrl: publicBaseUrl(req), orgId: m.orgId, merchantName: m.merchantName })); } catch (err) { next(err); }
  });
  app.get(`${UCP_BASE}/.well-known/oauth-authorization-server`, async (req, res, next) => {
    try { const m = await resolveMerchant(req.params.orgId); res.json(oauthMetadata({ baseUrl: publicBaseUrl(req), orgId: m.orgId })); } catch (err) { next(err); }
  });

  // ── PUBLIC OAuth token (client_credentials) ─────────────────────────────────
  app.post(`${UCP_BASE}/oauth/token`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.grant_type !== 'client_credentials') throw new OpenwopError('validation_error', 'unsupported_grant_type', 400, {});
      const { token, scopes, expiresInSec } = await issueToken(m.tenantId, m.orgId, b.client_id, b.client_secret, Date.now());
      res.json({ access_token: token, token_type: 'Bearer', expires_in: expiresInSec, scope: scopes.join(' ') });
    } catch (err) { next(err); }
  });

  // ── PUBLIC catalog (open read) ──────────────────────────────────────────────
  app.get(`${UCP_BASE}/catalog`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      const items = (await listProducts(m.tenantId, m.orgId)).filter((p) => p.active).map(toUcpCatalogItem);
      res.json({ vertical: 'shopping', items });
    } catch (err) { next(err); }
  });
  app.get(`${UCP_BASE}/catalog/:productId`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      const p = await getProduct(m.tenantId, m.orgId, req.params.productId);
      if (!p || !p.active) throw new OpenwopError('not_found', 'Item not found.', 404, {});
      res.json(toUcpCatalogItem(p));
    } catch (err) { next(err); }
  });

  // ── PUBLIC cart (bearer + scope; one cart per agent subject — composes the commerce
  //    cart store keyed by the token's subject, never a new store) ──────────────
  // Resolve the cart lines' products for the projection. Each `getProduct` is a keyed point
  // lookup (not a scan), and the deduped lookups run CONCURRENTLY (`Promise.all`) so the cart
  // read costs one round-trip of latency, not N sequential ones (UCP-C1).
  const cartProducts = async (tenantId: string, orgId: string, productIds: string[]): Promise<Map<string, Product>> => {
    const ids = [...new Set(productIds)];
    const products = await Promise.all(ids.map((id) => getProduct(tenantId, orgId, id)));
    const map = new Map<string, Product>();
    for (const p of products) if (p) map.set(p.productId, p);
    return map;
  };
  app.get(`${UCP_BASE}/cart`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      const principal = await requireUcpScope(req, m.tenantId, m.orgId, 'cart:write');
      const cart = await getCart(m.tenantId, m.orgId, principal.subject);
      res.json(toUcpCart(cart, await cartProducts(m.tenantId, m.orgId, cart.lines.map((l) => l.productId))));
    } catch (err) { next(err); }
  });
  app.post(`${UCP_BASE}/cart/items`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      const principal = await requireUcpScope(req, m.tenantId, m.orgId, 'cart:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const productId = requireString(b.item_id ?? b.productId, 'item_id');
      const qty = Number(b.quantity ?? 1);
      if (!Number.isFinite(qty) || qty < 0) throw new OpenwopError('validation_error', '`quantity` must be a non-negative number.', 400, { field: 'quantity' });
      // Only a real active product may enter the cart (an agent can't seed a phantom line).
      const p = await getProduct(m.tenantId, m.orgId, productId);
      if (!p || !p.active) throw new OpenwopError('validation_error', 'Unknown or inactive item.', 400, { field: 'item_id' });
      const cart = await setCartItem(m.tenantId, m.orgId, principal.subject, productId, qty);
      res.json(toUcpCart(cart, await cartProducts(m.tenantId, m.orgId, cart.lines.map((l) => l.productId))));
    } catch (err) { next(err); }
  });
  app.delete(`${UCP_BASE}/cart`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      const principal = await requireUcpScope(req, m.tenantId, m.orgId, 'cart:write');
      await clearCart(m.tenantId, m.orgId, principal.subject);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── PUBLIC checkout (bearer + scope) → commerce order ───────────────────────
  app.post(`${UCP_BASE}/checkout`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      const principal = await requireUcpScope(req, m.tenantId, m.orgId, 'checkout:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const couponCode = typeof b.coupon_code === 'string' ? b.coupon_code : undefined;
      // B3 (gap plan §5B): UCP is an AGENT path — an at/over-threshold checkout parks
      // a commerce-spend approval (409 approval_required) instead of creating.
      const order = await checkoutCart(m.tenantId, m.orgId, principal.subject, { ...(couponCode ? { couponCode } : {}), requireApprovalOverThreshold: true });
      res.status(201).json(toUcpOrder(order));
    } catch (err) { next(err); }
  });

  // ── PUBLIC order status (bearer + scope) ────────────────────────────────────
  app.get(`${UCP_BASE}/orders/:orderId`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      await requireUcpScope(req, m.tenantId, m.orgId, 'orders:read');
      const order = await getOrder(m.tenantId, m.orgId, req.params.orderId);
      if (!order) throw new OpenwopError('not_found', 'Order not found.', 404, {});
      res.json(toUcpOrder(order));
    } catch (err) { next(err); }
  });

  // ── PUBLIC AP2 payment (Phase 3) — bearer + checkout:write. Translate an AP2 mandate
  //    into a commerce payment intent → markAsPaid (demo-mode; the whole lifecycle —
  //    inventory, commission, order-confirmation notification/email — rides commerce). ──
  app.post(`${UCP_BASE}/orders/:orderId/pay`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      await requireUcpScope(req, m.tenantId, m.orgId, 'checkout:write');
      const order = await getOrder(m.tenantId, m.orgId, req.params.orderId);
      if (!order) throw new OpenwopError('not_found', 'Order not found.', 404, {});
      const { paymentIntentId, mode, warnings } = resolveAp2Payment((req.body ?? {}) as Record<string, unknown>, order);
      const paid = await markAsPaid(m.tenantId, m.orgId, order.orderId, paymentIntentId);
      if (!paid) throw new OpenwopError('not_found', 'Order not found.', 404, {});
      res.json({ order: toUcpOrder(paid), payment: { mode, intent_id: paymentIntentId, warnings } });
    } catch (err) { next(err); }
  });

  // ── PUBLIC cancel (Phase 3) — a buyer-agent cancels a still-pending order. ──
  app.post(`${UCP_BASE}/orders/:orderId/cancel`, async (req, res, next) => {
    try {
      const m = await resolveMerchant(req.params.orgId);
      await requireUcpScope(req, m.tenantId, m.orgId, 'checkout:write');
      const canceled = await cancelOrder(m.tenantId, m.orgId, req.params.orderId);
      if (!canceled) throw new OpenwopError('not_found', 'Order not found.', 404, {});
      res.json(toUcpOrder(canceled));
    } catch (err) { next(err); }
  });
}
