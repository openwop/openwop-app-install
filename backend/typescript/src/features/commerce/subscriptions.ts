/**
 * Product subscriptions (ADR 0279 / MERCH-E) — subscribe-and-save. EXTENDS the
 * commerce package (no new package/toggle): a buy-side `ProductSubscription` store
 * (distinct DIRECTION from the sell-side `Order`, like `UcpPurchase`) + the recurring
 * order cycle. COMPOSES `createOrder` (the discounted period order rides the internal
 * unitPriceOverride seam — a subscription's negotiated recurring price) and, in LIVE
 * mode, the single `billing/stripeApi` client as the recurrence clock.
 *
 * Demo-mode default (ADR 0279 posture): without a Stripe key the subscription is
 * RECORDED and the first period order is placed, but no live recurring charge is set
 * up (`paymentMode:'demo'`, honest `not_configured`) — byte-identical to the rest of
 * commerce/billing demo posture. Live Stripe-subscription creation + the invoice.paid
 * webhook that drives each cycle is the operator last-mile (the ONLY recurrence clock;
 * no host tick).
 *
 * @see docs/adr/0279-merch-e-product-subscriptions.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { getProduct, getOrder, createOrder, markAsPaid, quantizeMoney, type Order, type SubscriptionInterval, SUBSCRIPTION_INTERVALS } from './commerceService.js';
import { resolvePrice } from './pricing.js';
import { setSubscriptionInvoiceHook } from '../billing/subscriptionInvoiceHook.js';
import { onProductDeleted } from './productLifecycleSeam.js';
import { createStripeSubscription, cancelStripeSubscription } from '../billing/stripeApi.js';
import { getContact } from '../crm/contactsService.js';
import { createLogger } from '../../observability/logger.js';
import { recordCommerceAction } from './telemetry.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { STRIPE_KEY_REF } from '../billing/billingService.js';

const log = createLogger('commerce.subscriptions');

const nowIso = (): string => new Date().toISOString();
// R2 CM-P2-I3 — the recurring unit price is quantized in the PRODUCT's currency.
const INTERVAL_MS: Record<SubscriptionInterval, number> = {
  weekly: 7 * 864e5, monthly: 30 * 864e5, quarterly: 90 * 864e5, yearly: 365 * 864e5,
};

export interface ProductSubscription {
  subscriptionId: string; tenantId: string; orgId: string;
  productId: string; variantId?: string;
  contactId?: string;
  interval: SubscriptionInterval;
  /** The DISCOUNTED recurring unit price (resolvePrice × (1 − savePercent/100)), frozen. */
  unitPrice: number; currency: string;
  status: 'active' | 'canceled';
  /** demo = recorded, no live recurring charge; live = a Stripe subscription drives it. */
  paymentMode: 'demo' | 'live';
  /** R2 CM-P2-B2 — a key WAS configured but the Stripe subscription call failed, so this
   *  is a demo RECORD of a live intent. The first order stays PENDING (no auto-grant), and
   *  the degrade is distinguishable from a deliberate demo subscribe — which it was not
   *  before. Honest scope (review M-6): nothing RENDERS this yet (there is no subscription
   *  UI), so it reaches an operator via the API response and the log line only; a surface
   *  is deferred with the other lanes in the tracker. */
  degradedFromLive?: true;
  stripeSubscriptionId?: string;
  nextOrderAt: string;
  lastOrderId?: string;
  /** MERCH-E (ADR 0279 /architect finding 1) — the Stripe invoice id of the last period
   *  order placed. A re-delivered `invoice.paid` for the same invoice no-ops (idempotent
   *  per invoice, beyond billing's event.id dedupe). */
  lastInvoiceId?: string;
  createdBy: string; createdAt: string; updatedAt: string;
}

const subs = new DurableCollection<ProductSubscription>('commerce:product-sub', (s) => s.subscriptionId, undefined, (s) => s.tenantId);

export async function listProductSubscriptions(tenantId: string, orgId: string): Promise<ProductSubscription[]> {
  return (await subs.listForTenantIndexed(tenantId)).filter((s) => s.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getProductSubscription(tenantId: string, orgId: string, subscriptionId: string): Promise<ProductSubscription | null> {
  const s = await subs.get(subscriptionId);
  return s && s.tenantId === tenantId && s.orgId === orgId ? s : null;
}
/** Resolve a product subscription by its Stripe subscription id within a tenant — the
 *  `invoice.paid` webhook bridge (MERCH-E). Tenant-scoped (no cross-tenant leak). */
export async function getProductSubscriptionByStripeId(tenantId: string, stripeSubscriptionId: string): Promise<ProductSubscription | null> {
  return (await subs.listForTenantIndexed(tenantId)).find((s) => s.stripeSubscriptionId === stripeSubscriptionId) ?? null;
}

/** Subscribe a customer to a product at a save-and-save cadence. Validates the product
 *  opts in + supports the interval, freezes the discounted price, records the
 *  subscription, and places the FIRST period order immediately. Demo-mode by default
 *  (no live Stripe charge; `paymentMode:'demo'`). */
export async function subscribeToProduct(input: {
  tenantId: string; orgId: string; createdBy: string; productId: string; interval: unknown; contactId?: string; stripeKey?: string | null; idempotencyKey?: string;
}): Promise<{ subscription: ProductSubscription; firstOrder: Order; providerError?: string }> {
  const product = await getProduct(input.tenantId, input.orgId, input.productId);
  if (!product) throw new OpenwopError('validation_error', 'Product not found.', 400, { productId: input.productId });
  if (!product.subscription?.enabled) throw new OpenwopError('validation_error', 'This product is not available as a subscription.', 400, { productId: input.productId, code: 'not_subscribable' });
  const interval = String(input.interval) as SubscriptionInterval;
  if (!(SUBSCRIPTION_INTERVALS as readonly string[]).includes(interval) || !product.subscription.intervals.includes(interval)) {
    throw new OpenwopError('validation_error', `Unsupported interval. Product offers: ${product.subscription.intervals.join(', ')}`, 400, { field: 'interval' });
  }
  const base = (await resolvePrice(input.tenantId, input.orgId, product, { buyer: { ...(input.contactId ? { contactId: input.contactId } : {}) } })).price;
  const save = product.subscription.savePercent ?? 0;
  const unitPrice = quantizeMoney(base * (1 - save / 100), product.currency);
  const paymentMode: 'demo' | 'live' = input.stripeKey ? 'live' : 'demo';
  const now = nowIso();
  const subscriptionId = `psub:${randomUUID()}`;
  // Place the first period order at the discounted price (the internal override seam —
  // a subscription's negotiated recurring price; route callers never populate it).
  const firstOrder = await createOrder({
    tenantId: input.tenantId, orgId: input.orgId, createdBy: input.createdBy,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    lines: [{ productId: input.productId, quantity: 1, unitPriceOverride: unitPrice }],
  });
  // LIVE mode (a Stripe key is configured) — create the REAL recurring subscription; its
  // invoice.paid events drive each subsequent period order via the billing seam. Best-effort:
  // a Stripe failure never blocks the (already-placed) first order — we degrade to demo.
  let stripeSubscriptionId: string | undefined;
  let mode: 'demo' | 'live' = paymentMode;
  let providerError: string | undefined;
  const stripeConfigured = !!input.stripeKey;
  if (input.stripeKey) {
    try {
      const email = input.contactId ? (await getContact(input.contactId).catch(() => null))?.email : undefined;
      const created = await createStripeSubscription(input.stripeKey, {
        ...(email ? { email } : {}), unitPrice, currency: product.currency, interval, productName: product.name,
        metadata: { productSubscriptionId: subscriptionId, tenantId: input.tenantId, orgId: input.orgId },
      });
      stripeSubscriptionId = created.subscriptionId;
    } catch (e) {
      // R2 CM-P2-B2 — degrade the RECORD, never the money. `mode` is what we managed to
      // set up; `stripeConfigured` is what the operator asked for. Conflating them let a
      // rate-limited Stripe call mark the first order PAID below (see the auto-grant).
      mode = 'demo'; providerError = e instanceof Error ? e.message : String(e);
      log.warn('live Stripe subscription failed — recorded as demo', { subscriptionId, error: providerError });
    }
  }
  const sub: ProductSubscription = {
    subscriptionId, tenantId: input.tenantId, orgId: input.orgId, productId: input.productId,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    interval, unitPrice, currency: product.currency, status: 'active', paymentMode: mode,
    ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
    ...(providerError ? { degradedFromLive: true as const } : {}),
    nextOrderAt: new Date(Date.parse(now) + INTERVAL_MS[interval]).toISOString(),
    lastOrderId: firstOrder.orderId,
    createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await subs.put(sub);
  // ADR 0450 — a DEMO subscribe grants immediately: there is no Stripe
  // `invoice.paid` to drive fulfilment, so the first period order is marked PAID
  // here (the demo/operator subscribe IS the confirmation), firing the entitlement
  // grant. LIVE mode leaves the first order `pending` — the Stripe subscription's
  // first `invoice.paid` drives the grant through `runSubscriptionCycle`.
  // R2 CM-P2-B2 — the auto-grant is gated on the GENUINE demo posture (no key
  // configured), not on the post-catch `mode`. A configured store whose Stripe call
  // failed leaves the first order PENDING: marking it paid fired the whole paid
  // fan-out — GMV, conversion event, confirmation email, affiliate commission, a WON
  // deal and an entitlement grant — on zero money collected, traced only by a log line.
  const placedFirst = !stripeConfigured
    ? (await markAsPaid(input.tenantId, input.orgId, firstOrder.orderId, `subinit:${subscriptionId}`, {}) ?? firstOrder)
    : firstOrder;
  return { subscription: sub, firstOrder: placedFirst, ...(providerError ? { providerError } : {}) };
}

/** Run one recurring cycle — the function the LIVE Stripe `invoice.paid` webhook (or a
 *  demo-mode operator/scheduler) calls to place the next period order. Advances
 *  `nextOrderAt`. Stripe is the recurrence CLOCK in live mode (no host tick).
 *  Idempotent per `invoiceId` (ADR 0279 /architect finding 1): a re-delivered invoice
 *  no-ops, so a hook-throw-then-retry never double-orders. */
export async function runSubscriptionCycle(tenantId: string, orgId: string, subscriptionId: string, invoiceId?: string): Promise<Order | null> {
  const sub = await getProductSubscription(tenantId, orgId, subscriptionId);
  if (!sub || sub.status !== 'active') return null;
  if (invoiceId && sub.lastInvoiceId === invoiceId) return null; // already placed this period's order
  // ADR 0450 OQ3 — in LIVE mode `subscribeToProduct` placed a first order and left it
  // `pending` for the FIRST `invoice.paid` to confirm. Before this, that invoice
  // created a SECOND order and paid that one, stranding the first as a permanent
  // pending row. Adopt instead: if this subscription has never seen an invoice and
  // its last order is still pending, THIS invoice is that order's payment.
  const pendingFirst = !sub.lastInvoiceId && sub.lastOrderId ? await getOrder(tenantId, orgId, sub.lastOrderId) : null;
  const order = pendingFirst && pendingFirst.status === 'pending'
    ? pendingFirst
    : await createOrder({
      tenantId, orgId, createdBy: sub.createdBy,
      ...(sub.contactId ? { contactId: sub.contactId } : {}),
      lines: [{ productId: sub.productId, quantity: 1, unitPriceOverride: sub.unitPrice }],
    });
  // ADR 0450 (OQ1 resolved) — the cycle is placed IN RESPONSE to a CONFIRMED
  // payment: the LIVE Stripe `invoice.paid` (already webhook-signature-verified
  // before this hook fires) or a trusted demo/operator trigger. So mark the order
  // PAID here — which fires the paid-observers, i.e. the entitlement RE-GRANT on
  // renewal (the whole point of ADR 0450). NO Stripe re-verification: the invoice
  // is the payment authority; the order carries no paymentIntent to check. Marked
  // BEFORE advancing `lastInvoiceId` so a mid-way failure re-runs rather than
  // stranding a `pending` order (markAsPaid is idempotent — a re-paid order no-ops).
  const paid = await markAsPaid(tenantId, orgId, order.orderId, invoiceId ?? `subcycle:${sub.subscriptionId}`, {});
  const next: ProductSubscription = {
    ...sub, lastOrderId: order.orderId,
    ...(invoiceId ? { lastInvoiceId: invoiceId } : {}),
    nextOrderAt: new Date(Date.parse(nowIso()) + INTERVAL_MS[sub.interval]).toISOString(), updatedAt: nowIso(),
  };
  await subs.put(next);
  return paid ?? order;
}

/** MERCH-E (ADR 0279) — register the billing `invoice.paid` → recurring-order bridge.
 *  Called once at boot from commerce's registerRoutes. Billing fires the hook (it never
 *  imports commerce); this handler resolves the product subscription + runs the cycle. */
export function registerSubscriptionRecurrence(): void {
  setSubscriptionInvoiceHook(async (e) => {
    const sub = await getProductSubscriptionByStripeId(e.tenantId, e.stripeSubscriptionId);
    if (sub) await runSubscriptionCycle(e.tenantId, sub.orgId, sub.subscriptionId, e.invoiceId);
  });
}

export async function cancelSubscription(tenantId: string, orgId: string, subscriptionId: string, opts: { stripeKey?: string | null } = {}): Promise<ProductSubscription | null> {
  const sub = await getProductSubscription(tenantId, orgId, subscriptionId);
  if (!sub) return null;
  // R2 CM-P2-M8 — cancel it AT STRIPE first, and fail loudly if that fails. Writing the
  // local `canceled` alone stopped the recurring ORDERS while the recurring CHARGES
  // continued forever, with the customer's cancellation confirmed on screen. A local-only
  // cancel is honest ONLY when there is nothing provider-side to cancel.
  if (sub.stripeSubscriptionId && opts.stripeKey) {
    try {
      await cancelStripeSubscription(opts.stripeKey, sub.stripeSubscriptionId);
    } catch (err) {
      // Already gone at the provider ⇒ SUCCESS, so the local row can still reach
      // `canceled` (review M-5). Without this a lost response wedged the pair: every
      // retry re-hit Stripe, Stripe refused the repeat, and the subscription stayed
      // `active` while the cancel button kept failing — structurally the same wedge
      // CM-P2-B1 just removed from refunds.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such subscription|already.*cancel|resource_missing/i.test(msg)) throw err;
      log.info('stripe subscription already canceled at the provider — completing the local cancel', { subscriptionId });
    }
  } else if (sub.stripeSubscriptionId) {
    throw new OpenwopError('validation_error', 'This subscription bills through Stripe and no Stripe key is configured — cancelling here would stop the orders while the charges continued. Configure the key, then cancel.', 409, { subscriptionId, provider: 'stripe' });
  }
  const next: ProductSubscription = { ...sub, status: 'canceled', updatedAt: nowIso() };
  await subs.put(next);
  return next;
}

/**
 * grade-data: when a product is deleted, cancel its active subscriptions. Without this,
 * an `active` ProductSubscription outlives its product and `runSubscriptionCycle` keeps
 * minting recurring orders for a deleted `productId` (it never re-checks the product
 * exists). Registers into the commerce product-lifecycle seam (commerce can't import
 * this module back — it would cycle). Keyed + idempotent, so a repeated boot is safe.
 *
 * R2 CM-P2-M8 — the "documented follow-up" this note used to describe (cancel the
 * customer's STRIPE subscription too) is now implementable, so it is done here: the
 * cleanup resolves the key and cancels provider-side. What it must NOT do is take the
 * new local-only refusal as a reason to fail the product delete, nor quietly write
 * `canceled` over a subscription that is still charging the customer — a Stripe-linked
 * subscription we cannot cancel stays ACTIVE (its orders keep flowing, which is the
 * honest posture while the customer is still being billed) and is recorded for the
 * operator instead of being silently mislabelled.
 */
export function registerProductDeletionCleanup(): void {
  onProductDeleted('subscriptions', async ({ tenantId, orgId, productId }) => {
    const active = (await listProductSubscriptions(tenantId, orgId)).filter((s) => s.productId === productId && s.status === 'active');
    const stripeKey = await resolveSecret(STRIPE_KEY_REF).catch(() => null);
    for (const s of active) {
      try {
        await cancelSubscription(tenantId, orgId, s.subscriptionId, { stripeKey });
      } catch (err) {
        log.warn('product-deletion cleanup could not cancel a provider-billed subscription', { subscriptionId: s.subscriptionId, error: err instanceof Error ? err.message : String(err) });
        recordCommerceAction('subscription.cancel-blocked', s, 'system', { subscriptionId: s.subscriptionId, productId, provider: 'stripe', reason: 'provider_cancel_unavailable' });
      }
    }
  });
}

/** Test-only: write a subscription row directly (shapes a LIVE-mode state no demo path can reach). */
export async function __putSubscriptionForTest(sub: ProductSubscription): Promise<void> {
  await subs.put(sub);
}

export async function __resetSubscriptions(): Promise<void> {
  await subs.__clear();
}
