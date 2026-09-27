/**
 * Connect-event hook (ADR 0385 Phase 1) — the dependency-safe seam by which the
 * COMMERCE-CONNECT marketplace feature receives verified Stripe Connect events off
 * billing's ONE public webhook endpoint, WITHOUT billing importing commerce-connect
 * (the `subscriptionInvoiceHook`/`setOrderDiscountHook` inversion). Billing OWNS
 * this hook + fires it; `commerce-connect/feature.ts` registers the handler at
 * boot. Default = `handled:false` ⇒ billing is byte-identical when the feature is
 * absent or OFF.
 *
 * Contract (ADR 0385 correction note): billing's `event.id` CAS lives INSIDE
 * `processStripeEvent`, which Connect events never reach (they carry no
 * resolvable customer/tenant), so the hook fires AFTER signature verification but
 * BEFORE any billing dedup — the HANDLER owns its own event-level and
 * entity-level idempotency (`commerce-connect:webhook-event`). Unlike
 * `fireSubscriptionInvoicePaid`, a handler error PROPAGATES: the handler is the
 * event's primary processor, and only a 5xx from the webhook route makes Stripe
 * retry (a swallowed error would be acked 202 and lost). The handler releases its
 * idempotency claim on error so the retry reprocesses.
 */

/** The signature-verified Stripe event handed to the Connect handler. */
export interface ConnectStripeEvent {
  id: string;
  type: string;
  /** Top-level `event.account` — present on connected-account events only. */
  account?: string;
  data?: unknown;
}

type ConnectEventHook = (e: { event: ConnectStripeEvent }) => Promise<{ handled: boolean }>;

let hook: ConnectEventHook | null = null;

/** commerce-connect registers its webhook handler here at boot. */
export function setConnectEventHook(fn: ConnectEventHook | null): void { hook = fn; }

/** Called by billing's webhook route for Connect-scoped events. `handled:false`
 *  (unwired, feature off, or unknown account) lets the route fall through to its
 *  normal ack path with no effect. */
export async function fireConnectEvent(e: { event: ConnectStripeEvent }): Promise<{ handled: boolean }> {
  if (!hook) return { handled: false };
  return hook(e);
}
