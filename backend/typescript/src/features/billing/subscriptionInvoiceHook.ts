/**
 * Subscription-invoice hook (ADR 0279 / MERCH-E) — the dependency-safe seam by which the
 * COMMERCE product-subscriptions feature drives a recurring order off a Stripe
 * `invoice.paid`, WITHOUT billing importing commerce (billing is lower than commerce; the
 * `setTransactionalEmailTransport`/`setOrderDiscountHook` inversion). Billing OWNS this
 * hook + fires it; `commerce/subscriptions.ts` registers the handler. Default = no-op ⇒
 * billing is byte-identical when the product-subscriptions feature is absent/demo-mode.
 */
export interface SubscriptionInvoicePaid {
  tenantId: string;
  /** The Stripe subscription id on the paid invoice (`invoice.subscription`). */
  stripeSubscriptionId: string;
  /** The Stripe invoice id (`invoice.id`) — the handler dedupes the cycle on this so a
   *  re-delivered / retried event never places a second period order (ADR 0279 /architect
   *  finding 1: event.id idempotency is necessary but not sufficient). */
  invoiceId: string;
}

type SubscriptionInvoiceHook = (e: SubscriptionInvoicePaid) => Promise<void>;

let hook: SubscriptionInvoiceHook | null = null;

/** commerce/subscriptions.ts registers its `runSubscriptionCycle` bridge here at boot. */
export function setSubscriptionInvoiceHook(fn: SubscriptionInvoiceHook | null): void { hook = fn; }

/** Called by billing's `invoice.paid` branch; the documented no-op when unwired. Never
 *  throws into the webhook path (a subscription-cycle failure must not fail the whole
 *  Stripe event — it's retried on the next delivery). */
export async function fireSubscriptionInvoicePaid(e: SubscriptionInvoicePaid): Promise<void> {
  if (!hook || !e.stripeSubscriptionId) return;
  try { await hook(e); } catch { /* swallowed — the event is retried; the cycle dedupes by invoiceId */ }
}
