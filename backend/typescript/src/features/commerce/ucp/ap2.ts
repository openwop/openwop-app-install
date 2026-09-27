/**
 * AP2 payment intake for the UCP surface (ADR 0178 Phase 3). UCP's built-in payment layer
 * is AP2 (Agent Payments Protocol — a buyer presents a signed payment MANDATE / verifiable
 * credential authorizing a charge). This module translates an AP2 mandate into a commerce
 * PAYMENT INTENT id, which `commerceService.markAsPaid` records (the demo-mode posture the
 * whole commerce feature already takes — no capture, ADR 0177/0176).
 *
 * DEMO-MODE (default, no live PSP key): the mandate is accepted, its amount/currency are
 * cross-checked against the order (a real guard — a mismatched mandate is rejected), and
 * the order is marked paid against the derived intent id. NO money moves.
 *
 * DEFERRED / operator last-mile (needs live payment creds — the ADR 0176/0177 boundary):
 *   - full AP2 verifiable-credential signature verification (we do NOT trust-verify the VC
 *     here — flagged in `warnings`, never silently claimed as verified);
 *   - real settlement via the billing Stripe path (BYOK). When a live key is wired, the
 *     live branch routes here instead of the demo mark-paid.
 *
 * @see docs/adr/0178-ucp-universal-commerce-protocol.md
 */
import { randomBytes } from 'node:crypto';
import { OpenwopError } from '../../../types.js';
import { orderChargeTotal, type Order } from '../commerceService.js';
import { toStripeMinorUnits } from '../../billing/stripeApi.js';

export interface Ap2Resolution { paymentIntentId: string; mode: 'demo'; warnings: string[] }

/**
 * Resolve an AP2 payment request against an order into a payment intent id. Accepts either
 * a pre-authorized `payment_intent_id` (an external PSP already authorized) OR an
 * `ap2_mandate` (the buyer-agent's mandate). Fails closed when neither is present.
 */
export function resolveAp2Payment(body: Record<string, unknown>, order: Order): Ap2Resolution {
  const warnings: string[] = [];
  const preIntent = typeof body.payment_intent_id === 'string' && body.payment_intent_id.trim() ? body.payment_intent_id.trim() : null;
  const mandate = (body.ap2_mandate && typeof body.ap2_mandate === 'object') ? (body.ap2_mandate as Record<string, unknown>) : null;

  if (!preIntent && !mandate) {
    throw new OpenwopError('validation_error', 'An AP2 payment requires either `payment_intent_id` or `ap2_mandate`.', 400, { field: 'ap2_mandate' });
  }

  if (mandate) {
    // Cross-check the mandate's declared amount/currency against the order — a real guard
    // (a mandate authorizing a different amount MUST NOT settle this order).
    const amount = typeof mandate.amount === 'number' ? mandate.amount : undefined;
    const currency = typeof mandate.currency === 'string' ? mandate.currency.toUpperCase() : undefined;
    // R2 CM-P2-M11 — verify against what the buyer is actually CHARGED (goods + tax +
    // shipping), not the goods-only `total`, and REQUIRE the amount. Comparing to `total`
    // let a $90 mandate settle a $103 order with tax and shipping uncollected; an absent
    // amount skipped the check entirely, which is the whole point of a mandate.
    const charge = orderChargeTotal(order);
    if (amount === undefined) {
      throw new OpenwopError('validation_error', 'The AP2 mandate must state the `amount` it authorizes.', 400, { field: 'ap2_mandate.amount', expected: charge });
    }
    if (toStripeMinorUnits(amount, order.currency) !== toStripeMinorUnits(charge, order.currency)) {
      throw new OpenwopError('validation_error', 'AP2 mandate amount does not match the order charge (goods + tax + shipping).', 400, { expected: charge, got: amount });
    }
    // The M11 argument applies verbatim to currency (review I1): comparing minor units
    // ASSUMES the mandate is denominated in the order's currency, so an amount with no
    // currency settled a €103 order against a mandate that might have authorized $103.
    if (currency === undefined) {
      throw new OpenwopError('validation_error', 'The AP2 mandate must state the `currency` it authorizes.', 400, { field: 'ap2_mandate.currency', expected: order.currency });
    }
    if (currency !== order.currency) {
      throw new OpenwopError('validation_error', 'AP2 mandate currency does not match the order.', 400, { expected: order.currency, got: currency });
    }
    // We do NOT cryptographically verify the mandate VC here (demo-mode) — be HONEST about it.
    warnings.push('ap2_mandate_not_cryptographically_verified (demo-mode — VC verification is an operator last-mile step)');
  }

  const mandateId = mandate && typeof mandate.id === 'string' && mandate.id.trim() ? mandate.id.trim().slice(0, 80) : randomBytes(9).toString('hex');
  const paymentIntentId = preIntent ?? `ap2:${mandateId}`;
  return { paymentIntentId, mode: 'demo', warnings };
}
