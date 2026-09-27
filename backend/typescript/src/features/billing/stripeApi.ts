/**
 * Stripe API client (LEAK-11, ADR 0176/0177 correction notes) — the SINGLE
 * owner of Stripe HTTP in this app. Billing checkout/portal sessions and
 * commerce paymentIntent verification all dispatch through here.
 *
 * Egress discipline: the Stripe key is BYOK OPERATOR config
 * (`resolveSecret('billing:stripe-key')`), NOT a Connection — so this rides the
 * aiProviders/adsAdapter precedent (raw fetch to a HARDCODED, never
 * input-derived base; `OPENWOP_STRIPE_API_BASE` is a test override only), not
 * the Connections broker (forcing a non-Connection credential through
 * `brokeredPost` would invent a second credential model).
 *
 * Failure honesty: Stripe 401 → `credential_unavailable` (bad operator key,
 * actionable); other non-2xx → 502 `internal_error` carrying Stripe's
 * `error.message` ONLY (never the key, never the raw request); calls bounded
 * by a 15s timeout.
 */

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { assertEffectAllowed } from '../../host/runEffectContext.js';
import { providerIdempotencyKey } from '../../host/providerIdempotencyKey.js';

/** Stripe API base — hardcoded host (NEVER input-derived); test override only. */
function stripeApiBase(): string {
  return (process.env.OPENWOP_STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/+$/, '');
}

const STRIPE_TIMEOUT_MS = 15_000;

/**
 * Pin the Stripe API version (R-1 cutover, ADR 0176 open question). MyndHyve's
 * account runs `2025-12-15.clover`; pinning it here keeps BOTH our outgoing calls
 * AND — when the operator creates the cutover webhook endpoint at this version —
 * the event payload shapes aligned with the ported webhook handlers. Without it,
 * Stripe uses the account-default version, and a drift moves fields (e.g.
 * `current_period_end` onto the subscription ITEM) out from under the handlers.
 * Operator-overridable for a deliberate later upgrade.
 */
export const STRIPE_API_VERSION = process.env.OPENWOP_STRIPE_API_VERSION ?? '2025-12-15.clover';

async function stripeRequest(
  key: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  form?: Record<string, string>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  // ADR 0533 — money movement. Stripe's own idempotency key is passed on POSTs,
  // but it is minted per CALL and does not survive a fork, so it cannot dedupe a
  // replay (the same disjoint-key-space argument `replay.md` rule 2 makes about
  // idempotency Layer 2). Fail closed instead.
  assertEffectAllowed('payment', `stripe ${method} ${path}`);
  let res: Response;
  try {
    res = await fetch(`${stripeApiBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'stripe-version': STRIPE_API_VERSION, // pin the API version (R-1)
        ...(method === 'POST'
          ? {
              'content-type': 'application/x-www-form-urlencoded',
              // A caller-supplied idempotency key makes a logical operation (e.g. a
              // partial refund) safe to retry; otherwise a fresh key per call protects
              // only against undici's transport-level retries of the same request.
              // `idempotency.md` §Layer 2 Provider-key MUST: inject the EFFECT
              // IDENTITY, stable across retries. Order matters — an explicit
              // caller key still wins (it names a business operation the caller
              // knows better than we do, which is the preferred
              // `business-identity` keying); the run's effect identity is the
              // documented `activity-recipe` fallback; `randomUUID()` remains
              // ONLY for calls with no ambient run, where there is no effect to
              // key on and Layer 1 already covers the inbound request.
              //
              // The old code was `idempotencyKey ?? randomUUID()`, which on the
              // money-movement path meant a node re-attempt or a fork presented a
              // NEW key and Stripe could not dedupe it.
              'idempotency-key': idempotencyKey
                ?? providerIdempotencyKey({ operation: `${method} ${path}` })
                ?? randomUUID(),
            }
          : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OpenwopError(
      'internal_error',
      `Stripe request failed: ${err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error'}.`,
      502,
      { provider: 'stripe' },
    );
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
  if (res.status === 401) {
    throw new OpenwopError('credential_unavailable', 'Stripe rejected the configured API key — rotate `billing:stripe-key`.', 502, { provider: 'stripe' });
  }
  if (!res.ok) {
    // Stripe's structured message only — never the key, never the raw request.
    throw new OpenwopError('internal_error', `Stripe error: ${body.error?.message ?? `HTTP ${res.status}`}`, 502, { provider: 'stripe' });
  }
  return body;
}

/** Create a REAL Stripe Checkout Session; returns Stripe's own id + hosted URL.
 *  `metadata` rides the checkout session; `subscriptionMetadata` (subscription
 *  mode only) rides the CREATED subscription via `subscription_data[metadata]`
 *  so every `customer.subscription.*` lifecycle event — including `.deleted` —
 *  carries it (ADR 0419 bundle correlation). */
export async function createStripeCheckoutSession(
  key: string,
  input: {
    priceId: string;
    mode: 'subscription' | 'payment';
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    subscriptionMetadata?: Record<string, string>;
  },
): Promise<{ id: string; url: string }> {
  const params: Record<string, string> = {
    mode: input.mode,
    'line_items[0][price]': input.priceId,
    'line_items[0][quantity]': '1',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
  for (const [k, v] of Object.entries(input.metadata ?? {})) params[`metadata[${k}]`] = v;
  if (input.mode === 'subscription') {
    for (const [k, v] of Object.entries(input.subscriptionMetadata ?? {})) params[`subscription_data[metadata][${k}]`] = v;
  }
  const body = await stripeRequest(key, 'POST', '/v1/checkout/sessions', params);
  const id = typeof body.id === 'string' ? body.id : '';
  const url = typeof body.url === 'string' ? body.url : '';
  if (!id || !url) throw new OpenwopError('internal_error', 'Stripe returned a checkout session without id/url.', 502, { provider: 'stripe' });
  return { id, url };
}

/** Create a REAL Stripe Billing-Portal session for a stored customer. */
export async function createStripePortalSession(key: string, customerId: string, returnUrl: string): Promise<{ url: string }> {
  const body = await stripeRequest(key, 'POST', '/v1/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
  const url = typeof body.url === 'string' ? body.url : '';
  if (!url) throw new OpenwopError('internal_error', 'Stripe returned a portal session without a url.', 502, { provider: 'stripe' });
  return { url };
}

/** Fetch a PaymentIntent for verification (status/amount/currency). */
export async function getStripePaymentIntent(key: string, paymentIntentId: string): Promise<{ status: string; amount: number; currency: string }> {
  const body = await stripeRequest(key, 'GET', `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`);
  return {
    status: typeof body.status === 'string' ? body.status : 'unknown',
    amount: typeof body.amount === 'number' ? body.amount : NaN,
    currency: typeof body.currency === 'string' ? body.currency : '',
  };
}

/** Stripe zero-decimal currencies (amounts are already whole units). */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

/** Convert a major-unit order total to Stripe MINOR units, zero-decimal aware. */
export function toStripeMinorUnits(total: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(total) : Math.round(total * 100);
}

/** Convert Stripe MINOR units back to major units, zero-decimal aware (the
 *  inbound twin of toStripeMinorUnits — webhook amounts arrive minor). */
export function fromStripeMinorUnits(amountMinor: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? amountMinor : amountMinor / 100;
}

/** Create a REAL Stripe Checkout Session for an AD-HOC order (ecommerce gap plan
 *  §5C C2 — storefront checkout): `price_data` line items (no catalog price ids)
 *  + the order correlation metadata the commerce webhook flips `paid` on. Amounts
 *  are MINOR units (zero-decimal aware via toStripeMinorUnits at the caller). */
export async function createStripeOrderCheckoutSession(
  key: string,
  input: {
    lines: { name: string; amountMinor: number; currency: string; quantity: number }[];
    metadata: { orderId: string; tenantId: string; orgId: string };
    successUrl: string; cancelUrl: string;
    customerId?: string;
    setupFutureUsage?: 'off_session';
  },
): Promise<{ id: string; url: string }> {
  const params: Record<string, string> = {
    mode: 'payment',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // ADR 0296 P2 — explicit shopper consent saves the payment method for
    // one-click offers: attach the customer + off_session future usage.
    ...(input.customerId ? { customer: input.customerId } : {}),
    ...(input.setupFutureUsage ? { 'payment_intent_data[setup_future_usage]': input.setupFutureUsage } : {}),
    'payment_intent_data[metadata][orderId]': input.metadata.orderId,
    'payment_intent_data[metadata][tenantId]': input.metadata.tenantId,
    'payment_intent_data[metadata][orgId]': input.metadata.orgId,
    'metadata[orderId]': input.metadata.orderId,
    'metadata[tenantId]': input.metadata.tenantId,
    'metadata[orgId]': input.metadata.orgId,
  };
  input.lines.forEach((l, i) => {
    params[`line_items[${i}][quantity]`] = String(l.quantity);
    params[`line_items[${i}][price_data][currency]`] = l.currency.toLowerCase();
    params[`line_items[${i}][price_data][unit_amount]`] = String(l.amountMinor);
    params[`line_items[${i}][price_data][product_data][name]`] = l.name;
  });
  const body = await stripeRequest(key, 'POST', '/v1/checkout/sessions', params);
  const id = typeof body.id === 'string' ? body.id : '';
  const url = typeof body.url === 'string' ? body.url : '';
  if (!id || !url) throw new OpenwopError('internal_error', 'Stripe returned a checkout session without id/url.', 502, { provider: 'stripe' });
  return { id, url };
}

/** MERCH-E (ADR 0279) — create a REAL Stripe subscription for a PRODUCT subscription:
 *  resolve-or-create a customer (email-keyed, like the storefront checkout), then a
 *  subscription with INLINE recurring `price_data` (no per-product Stripe Price to
 *  pre-provision). `metadata[productSubscriptionId]` links it back for the `invoice.paid`
 *  bridge. Our cadence maps to Stripe's recurring interval + interval_count. */
const STRIPE_RECURRING: Record<string, { interval: string; count: number }> = {
  weekly: { interval: 'week', count: 1 }, monthly: { interval: 'month', count: 1 },
  quarterly: { interval: 'month', count: 3 }, yearly: { interval: 'year', count: 1 },
};
export async function createStripeSubscription(
  key: string,
  input: { email?: string; unitPrice: number; currency: string; interval: string; productName: string; metadata: Record<string, string> },
): Promise<{ subscriptionId: string; customerId: string }> {
  const cust = await stripeRequest(key, 'POST', '/v1/customers', input.email ? { email: input.email } : {});
  const customerId = typeof cust.id === 'string' ? cust.id : '';
  if (!customerId) throw new OpenwopError('internal_error', 'Stripe returned a customer without id.', 502, { provider: 'stripe' });
  const rec = STRIPE_RECURRING[input.interval] ?? STRIPE_RECURRING.monthly!;
  const params: Record<string, string> = {
    customer: customerId,
    'items[0][price_data][currency]': input.currency.toLowerCase(),
    'items[0][price_data][unit_amount]': String(toStripeMinorUnits(input.unitPrice, input.currency)),
    'items[0][price_data][recurring][interval]': rec.interval,
    'items[0][price_data][recurring][interval_count]': String(rec.count),
    'items[0][price_data][product_data][name]': input.productName,
  };
  for (const [k, v] of Object.entries(input.metadata)) params[`metadata[${k}]`] = v;
  const body = await stripeRequest(key, 'POST', '/v1/subscriptions', params);
  const subscriptionId = typeof body.id === 'string' ? body.id : '';
  if (!subscriptionId) throw new OpenwopError('internal_error', 'Stripe returned a subscription without id.', 502, { provider: 'stripe' });
  return { subscriptionId, customerId };
}

/** Issue a REAL Stripe refund for a payment intent (D4 — the refund last mile).
 *  Full-amount by default; pass `amountMinor` for a PARTIAL refund (ADR 0238 DEF-7).
 *  Stripe's `/v1/refunds` takes an integer `amount` in the charge's minor units;
 *  omitting it refunds the full remaining amount. An `idempotencyKey` (routed as the
 *  Idempotency-Key header) makes a retried partial refund a no-op instead of a second
 *  charge-back. */
export async function createStripeRefund(
  key: string,
  paymentIntentId: string,
  opts: { amountMinor?: number; idempotencyKey?: string; reverseTransfer?: boolean } = {},
): Promise<{ id: string; status: string }> {
  const params: Record<string, string> = { payment_intent: paymentIntentId };
  // ADR 0385 P5 — destination-charge refund: pull the seller's share back from
  // the connected account (best-effort creator recovery; the platform still
  // fronts the buyer's refund either way).
  if (opts.reverseTransfer) params.reverse_transfer = 'true';
  if (opts.amountMinor !== undefined) {
    if (!Number.isInteger(opts.amountMinor) || opts.amountMinor <= 0) {
      throw new OpenwopError('validation_error', 'A partial refund amount must be a positive integer in minor units.', 400, { provider: 'stripe' });
    }
    params.amount = String(opts.amountMinor);
  }
  const body = await stripeRequest(key, 'POST', '/v1/refunds', params, opts.idempotencyKey);
  const id = typeof body.id === 'string' ? body.id : '';
  const status = typeof body.status === 'string' ? body.status : '';
  if (!id) throw new OpenwopError('internal_error', 'Stripe returned a refund without an id.', 502, { provider: 'stripe' });
  return { id, status };
}

/** R2 CM-P2-M8 — cancel a Stripe subscription. Without this the app's "cancel"
 *  stopped the recurring ORDERS while the recurring CHARGES continued forever. */
export async function cancelStripeSubscription(key: string, subscriptionId: string): Promise<{ id: string; status: string }> {
  const body = await stripeRequest(key, 'DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const id = typeof body.id === 'string' ? body.id : '';
  const status = typeof body.status === 'string' ? body.status : '';
  if (!id) throw new OpenwopError('internal_error', 'Stripe returned a subscription cancel without an id.', 502, { provider: 'stripe' });
  return { id, status };
}

/** ADR 0385 P1 — create a Stripe Connect EXPRESS account for a seller tenant.
 *  Express: Stripe hosts onboarding/KYC + the seller dashboard; the platform
 *  keeps charge control (destination charges, Phase 2). `metadata.tenantId`
 *  correlates the account back without trusting webhook payload contents. */
export async function createStripeConnectAccount(
  key: string,
  input: { country?: string; email?: string; metadata: Record<string, string> },
): Promise<{ accountId: string; country: string }> {
  const params: Record<string, string> = {
    type: 'express',
    ...(input.country ? { country: input.country.toUpperCase() } : {}),
    ...(input.email ? { email: input.email } : {}),
  };
  for (const [k, v] of Object.entries(input.metadata)) params[`metadata[${k}]`] = v;
  const body = await stripeRequest(key, 'POST', '/v1/accounts', params);
  const accountId = typeof body.id === 'string' ? body.id : '';
  if (!accountId) throw new OpenwopError('internal_error', 'Stripe returned a Connect account without an id.', 502, { provider: 'stripe' });
  return { accountId, country: typeof body.country === 'string' ? body.country : '' };
}

/** ADR 0385 P1 — mint a SINGLE-USE hosted onboarding link for a Connect account.
 *  Links expire and are one-shot by design, so minting a fresh one per request is
 *  the correct (not merely tolerated) behavior. */
export async function createStripeAccountLink(
  key: string,
  input: { accountId: string; refreshUrl: string; returnUrl: string },
): Promise<{ url: string }> {
  const body = await stripeRequest(key, 'POST', '/v1/account_links', {
    account: input.accountId,
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
    type: 'account_onboarding',
  });
  const url = typeof body.url === 'string' ? body.url : '';
  if (!url) throw new OpenwopError('internal_error', 'Stripe returned an account link without a url.', 502, { provider: 'stripe' });
  return { url };
}

/** ADR 0385 P1 — read a Connect account's live state (the onboarding-return
 *  sync; the webhook keeps it current thereafter). */
export async function getStripeConnectAccount(
  key: string,
  accountId: string,
): Promise<{
  accountId: string; chargesEnabled: boolean; payoutsEnabled: boolean;
  detailsSubmitted: boolean; country: string; activeCapabilities: string[];
  requirementsDisabledReason?: string;
}> {
  const body = await stripeRequest(key, 'GET', `/v1/accounts/${encodeURIComponent(accountId)}`);
  const caps = (body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {}) as Record<string, unknown>;
  const reqs = (body.requirements && typeof body.requirements === 'object' ? body.requirements : {}) as Record<string, unknown>;
  return {
    accountId: typeof body.id === 'string' ? body.id : accountId,
    chargesEnabled: body.charges_enabled === true,
    payoutsEnabled: body.payouts_enabled === true,
    detailsSubmitted: body.details_submitted === true,
    country: typeof body.country === 'string' ? body.country : '',
    activeCapabilities: Object.entries(caps).filter(([, v]) => v === 'active').map(([k]) => k),
    ...(typeof reqs.disabled_reason === 'string' && reqs.disabled_reason ? { requirementsDisabledReason: reqs.disabled_reason } : {}),
  };
}

/** ADR 0385 P2 — create a DESTINATION-CHARGE Checkout Session for a marketplace
 *  purchase: the platform is the merchant, keeps `application_fee_amount`, and
 *  transfers the remainder to the seller's connected account. `ccOrderId` rides
 *  BOTH the session and the payment-intent metadata so either success event
 *  (`checkout.session.completed` / `payment_intent.succeeded`) routes back to
 *  the order. The idempotency key is the caller's deterministic orderId — a
 *  retried create returns the same session, never a second charge. */
export async function createStripeConnectCheckoutSession(
  key: string,
  input: {
    name: string; amountMinor: number; currency: string;
    applicationFeeMinor: number; destinationAccountId: string;
    ccOrderId: string; successUrl: string; cancelUrl: string;
    idempotencyKey: string;
  },
): Promise<{ id: string; url: string }> {
  const params: Record<string, string> = {
    mode: 'payment',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': input.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(input.amountMinor),
    'line_items[0][price_data][product_data][name]': input.name,
    'payment_intent_data[application_fee_amount]': String(input.applicationFeeMinor),
    'payment_intent_data[transfer_data][destination]': input.destinationAccountId,
    'payment_intent_data[on_behalf_of]': input.destinationAccountId,
    'payment_intent_data[metadata][ccOrderId]': input.ccOrderId,
    'metadata[ccOrderId]': input.ccOrderId,
  };
  const body = await stripeRequest(key, 'POST', '/v1/checkout/sessions', params, input.idempotencyKey);
  const id = typeof body.id === 'string' ? body.id : '';
  const url = typeof body.url === 'string' ? body.url : '';
  if (!id || !url) throw new OpenwopError('internal_error', 'Stripe returned a checkout session without id/url.', 502, { provider: 'stripe' });
  return { id, url };
}

/** ADR 0296 P2 — create a Stripe Customer (the consent-to-save anchor). */
export async function createStripeCustomer(key: string, input: { email?: string }): Promise<{ customerId: string }> {
  const body = await stripeRequest(key, 'POST', '/v1/customers', input.email ? { email: input.email } : {});
  const customerId = typeof body.id === 'string' ? body.id : '';
  if (!customerId) throw new OpenwopError('internal_error', 'Stripe returned a customer without id.', 502, { provider: 'stripe' });
  return { customerId };
}

/** ADR 0296 P3 — charge a SAVED payment method off-session (the one-click
 *  upsell). Amount is always server-resolved by the caller (LEAK-11). Returns
 *  the terminal state rather than throwing on the two EXPECTED non-success
 *  outcomes: an SCA challenge (`requiresAction` + clientSecret for the
 *  on-session fallback) and a decline — the funnel must route on both. */
export async function createStripeOffSessionPaymentIntent(
  key: string,
  input: {
    customerId: string; paymentMethodId: string;
    amountMinor: number; currency: string;
    metadata: { orderId: string; tenantId: string; orgId: string };
    idempotencyKey: string;
  },
): Promise<
  | { outcome: 'succeeded'; paymentIntentId: string }
  | { outcome: 'requires_action'; paymentIntentId: string; clientSecret: string }
  | { outcome: 'declined'; reason: string }
> {
  const params: Record<string, string> = {
    amount: String(input.amountMinor),
    currency: input.currency.toLowerCase(),
    customer: input.customerId,
    payment_method: input.paymentMethodId,
    off_session: 'true',
    confirm: 'true',
    'metadata[orderId]': input.metadata.orderId,
    'metadata[tenantId]': input.metadata.tenantId,
    'metadata[orgId]': input.metadata.orgId,
  };
  // ADR 0533 — an off-session charge is the sharpest edge of all: a replay
  // would charge a saved card a second time.
  assertEffectAllowed('payment', 'stripe off-session payment intent');
  let res: Response;
  try {
    res = await fetch(`${stripeApiBase()}/v1/payment_intents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': input.idempotencyKey,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OpenwopError('internal_error', `Stripe request failed: ${err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error'}.`, 502, { provider: 'stripe' });
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; status?: unknown; client_secret?: unknown; error?: { code?: string; decline_code?: string; message?: string; payment_intent?: { id?: unknown; client_secret?: unknown } } };
  if (res.status === 401) {
    throw new OpenwopError('credential_unavailable', 'Stripe rejected the configured API key — rotate `billing:stripe-key`.', 502, { provider: 'stripe' });
  }
  if (res.ok && body.status === 'succeeded' && typeof body.id === 'string') {
    return { outcome: 'succeeded', paymentIntentId: body.id };
  }
  // Stripe reports an off-session SCA challenge as an error carrying the intent.
  const err = body.error;
  if (err?.code === 'authentication_required' && typeof err.payment_intent?.id === 'string' && typeof err.payment_intent?.client_secret === 'string') {
    return { outcome: 'requires_action', paymentIntentId: err.payment_intent.id, clientSecret: err.payment_intent.client_secret };
  }
  if (err?.code === 'card_declined' || err?.decline_code) {
    return { outcome: 'declined', reason: err.decline_code ?? err.code ?? 'card_declined' };
  }
  throw new OpenwopError('internal_error', `Stripe error: ${err?.message ?? `HTTP ${res.status}`}`, 502, { provider: 'stripe' });
}
