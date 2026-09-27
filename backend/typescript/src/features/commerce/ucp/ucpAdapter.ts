/**
 * UCP ⇄ commerce projections + discovery documents (ADR 0178 Phase 1).
 *
 * This module owns ONLY the shape translation between the UCP protocol and the commerce
 * source of truth — it holds NO state and never writes an order/cart/product (commerce
 * does). Every projection is a pure function of a commerce entity. The discovery docs are
 * UCP's OWN well-known contract (never `/.well-known/openwop` — see the ADR RFC gate).
 *
 * @see docs/adr/0178-ucp-universal-commerce-protocol.md
 */
import type { Product, Cart, Order, OrderItem } from '../commerceService.js';
import { UCP_SCOPES } from './ucpClientStore.js';
import { vendorPublicBase } from '../../featureRoute.js';

/** The UCP spec version this adapter conforms to (Shopping vertical). Pinned; revisit on
 *  UCP updates (ADR open question). */
export const UCP_VERSION = '2025-draft';
export const UCP_VERTICAL = 'shopping';

export interface UcpMoney { amount: number; currency: string }
export interface UcpCatalogItem {
  id: string; type: Product['type']; title: string; description: string;
  price: UcpMoney; availability: 'in_stock' | 'out_of_stock';
  images: string[];
  variants: { id: string; title: string; price?: UcpMoney }[];
}

export function toUcpCatalogItem(p: Product): UcpCatalogItem {
  const inStock = p.type !== 'physical' || p.inventory === undefined || p.inventory > 0;
  return {
    id: p.productId, type: p.type, title: p.name, description: p.description ?? '',
    price: { amount: p.price, currency: p.currency },
    availability: inStock ? 'in_stock' : 'out_of_stock',
    images: p.imageAssetTokens,
    variants: p.variants.map((v) => ({ id: v.variantId, title: v.name, ...(v.price !== undefined ? { price: { amount: v.price, currency: p.currency } } : {}) })),
  };
}

export interface UcpCartLine { item_id: string; quantity: number; title: string; unit_price: UcpMoney }
export interface UcpCart { id: string; lines: UcpCartLine[]; subtotal: UcpMoney; updated_at: string }

/** Project the commerce cart, resolving each line's product for title/price (the storefront
 *  read already active-filters; an unknown/removed product line is dropped from the view). */
export function toUcpCart(cart: Cart, products: Map<string, Product>): UcpCart {
  const lines: UcpCartLine[] = [];
  let subtotal = 0;
  let currency = 'USD';
  for (const l of cart.lines) {
    const p = products.get(l.productId);
    if (!p) continue;
    lines.push({ item_id: p.productId, quantity: l.quantity, title: p.name, unit_price: { amount: p.price, currency: p.currency } });
    subtotal += p.price * l.quantity;
    currency = p.currency;
  }
  return { id: cart.cartId, lines, subtotal: { amount: Math.round(subtotal * 100) / 100, currency }, updated_at: cart.updatedAt };
}

export interface UcpOrder {
  id: string; status: Order['status']; fulfillment_status: Order['fulfillmentStatus'];
  line_items: { item_id: string; title: string; quantity: number; unit_price: UcpMoney }[];
  totals: { subtotal: UcpMoney; discount: UcpMoney; total: UcpMoney };
  payment: { status: 'paid' | 'unpaid'; intent_id?: string };
  created_at: string;
}

export function toUcpOrder(o: Order): UcpOrder {
  const money = (amount: number): UcpMoney => ({ amount, currency: o.currency });
  const line = (i: OrderItem) => ({ item_id: i.productId, title: i.name, quantity: i.quantity, unit_price: money(i.unitPrice) });
  return {
    id: o.orderId, status: o.status, fulfillment_status: o.fulfillmentStatus,
    line_items: o.items.map(line),
    totals: { subtotal: money(o.subtotal), discount: money(o.discount), total: money(o.total) },
    payment: { status: o.status === 'paid' || o.status === 'fulfilled' ? 'paid' : 'unpaid', ...(o.paymentIntentId ? { intent_id: o.paymentIntentId } : {}) },
    created_at: o.createdAt,
  };
}

/** The UCP discovery document for a merchant org (served at the org's `.well-known/ucp`). */
export function ucpDiscovery(input: { baseUrl: string; orgId: string; merchantName: string }): Record<string, unknown> {
  const root = `${vendorPublicBase(input.baseUrl)}/commerce/ucp/orgs/${input.orgId}`;
  return {
    ucp_version: UCP_VERSION,
    vertical: UCP_VERTICAL,
    merchant: { id: input.orgId, name: input.merchantName },
    merchant_of_record: input.orgId,
    authorization_server: `${root}/.well-known/oauth-authorization-server`,
    transports: {
      // Phase 1 ships REST; the MCP/A2A agent transports (Phase 2) advertise here when live —
      // advertise-only-what-is-honored (never claim a transport that is not wired).
      rest: {
        catalog: `${root}/catalog`,
        cart: `${root}/cart`,
        checkout: `${root}/checkout`,
        orders: `${root}/orders`,
      },
      mcp: null,
      a2a: null,
    },
    payment: { methods: ['ap2'], mode: 'demo' },
  };
}

/** OAuth 2.0 authorization-server metadata (RFC 8414 shape) for the merchant org. */
export function oauthMetadata(input: { baseUrl: string; orgId: string }): Record<string, unknown> {
  const root = `${vendorPublicBase(input.baseUrl)}/commerce/ucp/orgs/${input.orgId}`;
  return {
    issuer: root,
    token_endpoint: `${root}/oauth/token`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    scopes_supported: [...UCP_SCOPES],
  };
}
