/**
 * Subscription-invoice hook (ADR 0279 / MERCH-E) — the dependency-safe seam by which the
 * COMMERCE product-subscriptions feature drives a recurring order off a Stripe
 * `invoice.paid`, WITHOUT billing importing commerce (billing is lower than commerce; the
 * `setTransactionalEmailTransport`/`setOrderDiscountHook` inversion). Billing OWNS this
 * hook + fires it; `commerce/subscriptions.ts` registers the handler. Default = no-op ⇒
 * billing is byte-identical when the product-subscriptions feature is absent/demo-mode.
 */
import { createLogger } from '../../observability/logger.js';

const log = createLogger('billing');

export interface SubscriptionInvoicePaid {
  tenantId: string;
  /** The Stripe subscription id on the paid invoice (`parent.subscription_details.subscription`
   *  on the pinned clover API version; `invoice.subscription` before basil — ADR 0786 D3). */
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
 *  Stripe event).
 *
 *  ADR 0786 correction: the old comment said a failure "is retried on the next
 *  delivery". It is not — the webhook answers 2xx, so Stripe never redelivers, and
 *  the swallowed error was not even logged. It is now logged loudly so a lost
 *  period order is at least visible; whether to propagate (the cycle dedupes by
 *  invoiceId, so a retry is safe) is filed as BILLWF-20. */
export async function fireSubscriptionInvoicePaid(e: SubscriptionInvoicePaid): Promise<void> {
  if (!hook || !e.stripeSubscriptionId) return;
  try {
    await hook(e);
  } catch (err) {
    log.error('subscription invoice.paid hook failed — this period order was NOT placed and Stripe will not redeliver', {
      tenantId: e.tenantId, stripeSubscriptionId: e.stripeSubscriptionId, invoiceId: e.invoiceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
