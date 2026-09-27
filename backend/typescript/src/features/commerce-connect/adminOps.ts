/**
 * Commerce Connect — operator/admin operations: refunds, the dispute/loss
 * ledger reads, recent orders, and the id-preserving importer (ADR 0385
 * Phases 0/5; CC-6 split). All callers are superadmin-route-gated.
 */
import { OpenwopError } from '../../types.js';
import { createStripeRefund } from '../billing/stripeApi.js';
import {
  orders, disputes, sellers, accountIndex, nowIso, requireStripeKey, isFoldEligibleTenant,
  ENTITLED_ORDER_STATUSES,
  type SellerAccount, type OnboardingState, type ConnectOrder, type ConnectDispute,
} from './stores.js';
import { bindSellerAccount } from './stores.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.commerce-connect.adminOps');


/** All disputes (operator ledger read) + the platform-loss total. */
export async function listDisputes(): Promise<{ disputes: ConnectDispute[]; platformLossMajorUnitsByCurrency: Record<string, number> }> {
  const all = (await disputes.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const loss: Record<string, number> = {};
  for (const d of all) if (d.status === 'lost') loss[d.currency] = (loss[d.currency] ?? 0) + d.platformLossMajorUnits;
  return { disputes: all, platformLossMajorUnitsByCurrency: loss };
}


/** Operator view of recent orders (admin console; bounded, newest first). */
export async function listRecentOrders(limit = 100): Promise<ConnectOrder[]> {
  return (await orders.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, limit));
}


/**
 * Operator full refund of a paid order (superadmin route). Issues the Stripe
 * refund with `reverse_transfer` (best-effort creator recovery — a failure
 * surfaces typed; we never silently retry without the reversal, which would
 * change who eats the loss). The order flips `refunded` on the charge.refunded
 * WEBHOOK, not here (the ADR 0176 fulfilment discipline). Demo orders flip
 * immediately (no Stripe exists to deliver the webhook).
 *
 * MPL-4 — the RESPONSE IS HONEST ABOUT WHICH OF THOSE TWO HAPPENED, and the
 * request is durably stamped.
 *
 * This used to return `{ order, refundId }` with `order.status` still `'paid'`,
 * and the SPA rendered the 200 as success. If the `charge.refunded` delivery is
 * lost, mis-signed, or arrives with the metadata absent, the order stayed `paid`
 * FOREVER: `hasPaidOrder` kept returning true, `sellerStats` kept counting it, and
 * the console kept showing Paid — with nothing anywhere recording that a refund had
 * ever been issued. There was no order-side reconciliation (`reconcileSellerBindings`
 * covers account bindings only, and has no production caller of its own).
 *
 * Two changes, no change to the Stripe call or its idempotency key:
 *   1. `refundRequestedAt` + `refundId` are CAS-stamped on the order BEFORE the
 *      response, so the divergence between "requested" and "confirmed" is a
 *      readable fact rather than an absence. `exceptionSources.ts` projects a
 *      stamp older than `REFUND_CONFIRMATION_SLA_MS` with the order still ENTITLED
 *      into the operator exception feed.
 *
 *      CORRECTED (review fold-in): this used to read "a pull-based detector that
 *      cannot silently fail to run, unlike a sweep". That is true of its
 *      SCHEDULING and false of its INPUT, and the sentence quietly generalised
 *      the first into the second. The detector is keyed ENTIRELY on a stamp this
 *      function writes AFTER Stripe has already moved the money, so the window
 *      the detector was built for is precisely the window in which its input can
 *      fail to exist. The deleted sweep keyed on the Stripe refund LIST — an
 *      input that does not depend on our own write landing. The honest claim is
 *      narrower: the detector cannot fail to RUN, and it now cannot lose the
 *      stamp to an ordinary CAS race either (bounded retry below), but a process
 *      death between the Stripe 200 and the stamp still leaves an undetectable
 *      divergence. That residual is logged loudly rather than presumed absent,
 *      and closing it needs a Stripe-side reconciliation, not a better stamp.
 *   2. The wire says what it DID versus what it INITIATED: `applied` is true only
 *      when this call itself moved the row (the demo lane), and `state` names the
 *      real outcome. `MKT-UX-10`'s "the button is live again against an order
 *      still marked Paid" is the UI half of the same honesty gap.
 */
export interface RefundResult {
  order: ConnectOrder;
  refundId?: string;
  /** True only when THIS call changed the order's status (demo lane). On the live
   *  lane the flip rides `charge.refunded`, so this is false and `state` is
   *  `'initiated'` — never report an initiated refund as an applied one. */
  applied: boolean;
  state: 'applied' | 'initiated';
}

export async function refundOrder(orderId: string): Promise<RefundResult> {
  const order = await orders.get(orderId);
  if (!order) throw new OpenwopError('not_found', 'No such order.', 404, {});
  // `partially-refunded` is refundable for the remainder; `refunded`/`disputed`/
  // `pending`/`failed` are not. Spelled through the shared set (the same
  // symmetric-pair rule `hasPaidOrder` documents) — "still entitled" and "still
  // refundable" are the same predicate, and two literals here would drift.
  if (!ENTITLED_ORDER_STATUSES.has(order.status)) {
    throw new OpenwopError('validation_error', `Only a paid order can be refunded (status: ${order.status}).`, 409, { orderId });
  }
  if (order.mode === 'demo') {
    const now = nowIso();
    const refunded: ConnectOrder = {
      ...order, status: 'refunded',
      refundedMajorUnits: order.amountMajorUnits,
      refundRequestedAt: now, updatedAt: now,
    };
    await orders.compareAndSwap(order, refunded);
    return { order: (await orders.get(orderId)) ?? refunded, applied: true, state: 'applied' };
  }
  if (!order.stripePaymentIntentId) {
    throw new OpenwopError('validation_error', 'This order has no payment intent to refund.', 409, { orderId });
  }
  const key = await requireStripeKey();
  const refund = await createStripeRefund(key, order.stripePaymentIntentId, {
    reverseTransfer: true,
    idempotencyKey: `refund:${orderId}`,
  });
  // Stamp AFTER the Stripe call succeeded — stamping first would record a refund
  // that a thrown Stripe error means never happened. The CAS loser re-reads: a
  // concurrent `charge.refunded` that already flipped the row wins, and we return
  // the stored truth rather than overwriting it back to `paid`.
  //
  // MPL-4 (review fold-in) — THE STAMP IS THE DETECTOR'S ONLY INPUT, so losing
  // the CAS silently is losing the detection. A single blind attempt meant that a
  // concurrent writer (`handleDisputeEvent`, a purchase-anomaly stamp, a second
  // `refundOrder`) could take the row while the refund was already irreversible
  // at Stripe; if the `charge.refunded` webhook was then lost, the durable state
  // was money-returned + order-still-entitled + stats-still-counting + NO
  // exception row anywhere. Retry the losers whose re-read shows the row is STILL
  // entitled and STILL unstamped — the re-read is already in hand, so this costs
  // one extra CAS at most. Bounded, never a loop that can spin.
  const attempts = 2;
  let current: ConnectOrder = order;
  let landed = false;
  for (let i = 0; i < attempts; i++) {
    const stamped: ConnectOrder = { ...current, refundRequestedAt: nowIso(), refundId: refund.id, updatedAt: nowIso() };
    if (await orders.compareAndSwap(current, stamped)) { current = stamped; landed = true; break; }
    current = (await orders.get(orderId)) ?? current;
    // The webhook (or a peer) already recorded the refund — nothing to stamp, and
    // re-stamping would overwrite a MORE advanced truth with a less advanced one.
    if (current.refundRequestedAt || !ENTITLED_ORDER_STATUSES.has(current.status)) { landed = true; break; }
  }
  if (!landed) {
    // Residual window, stated rather than hidden: the refund IS irreversible at
    // Stripe and nothing durable records it, so the pull-based detector cannot
    // see it. Loud, attributable and carrying the operator's `refundId` — this is
    // the one branch where the log IS the record of last resort.
    log.error('commerce-connect refund stamp ABANDONED — refund is live at Stripe but the order carries no refundRequestedAt; the unconfirmed-refund detector cannot see this order', {
      orderId, refundId: refund.id, status: current.status,
    });
  }
  return { order: current, refundId: refund.id, applied: false, state: 'initiated' };
}


/** Phase 0 — id-preserving MyndHyve seller importer (superadmin route). Every
 *  `stripeAccountId` carries over verbatim against the same platform account,
 *  so sellers keep onboarding/capabilities/payout schedule (the ADR 0176 R-1
 *  importer semantics). */
export async function importSellers(rows: Partial<SellerAccount>[]): Promise<{ sellers: number; skipped: number; rejected: Array<{ tenantId: string; reason: string }> }> {
  let count = 0;
  let skipped = 0;
  // ADR 0576 — refusals are COUNTED AND NAMED, never silent: an import that
  // dropped a row used to be indistinguishable from one that landed it.
  const rejected: Array<{ tenantId: string; reason: string }> = [];
  const VALID_STATES: OnboardingState[] = ['pending', 'restricted', 'enabled', 'deauthorized'];
  for (const row of rows) {
    if (!row.tenantId || !row.stripeAccountId) { skipped++; continue; }
    // ADR 0576 / MPL-1 — the GEN-CC-1 fold guard, lane 4 of 4, through the ONE
    // shared predicate (`stores.isFoldEligibleTenant`). The non-throwing shape,
    // because this lane COUNTS AND NAMES its refusals instead of aborting the
    // batch on the first one. Correction: the comment that used to sit here
    // implied the guard was complete; it covered 2 of 4 lanes — see the
    // predicate's docblock.
    if (!isFoldEligibleTenant(row.tenantId)) { rejected.push({ tenantId: row.tenantId, reason: 'anon_tenant' }); continue; }
    // ADR 0576 — the binding invariant: a stripeAccountId already bound to a
    // DIFFERENT tenant is refused, never silently re-pointed (the old code
    // overwrote accountIndex, re-routing that account's webhook attribution).
    const bound = await accountIndex.get(row.stripeAccountId);
    if (bound && bound.tenantId !== row.tenantId) { rejected.push({ tenantId: row.tenantId, reason: 'account_already_bound' }); continue; }
    // Grade pass CC-10: the importer is a one-time continuity tool — it must
    // never clobber a LIVE row (a re-run could silently flip a restricted
    // seller back to enabled). Skip-if-exists; validate the state enum.
    if (await sellers.get(row.tenantId)) { skipped++; continue; }
    if (row.onboardingState !== undefined && !VALID_STATES.includes(row.onboardingState)) { skipped++; continue; }
    const now = nowIso();
    const seller: SellerAccount = {
      tenantId: row.tenantId,
      stripeAccountId: row.stripeAccountId,
      onboardingState: row.onboardingState ?? 'enabled',
      chargesEnabled: row.chargesEnabled ?? true,
      payoutsEnabled: row.payoutsEnabled ?? true,
      region: row.region ?? '',
      capabilities: row.capabilities ?? [],
      mode: 'live',
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    };
    await sellers.put(seller);
    await bindSellerAccount(seller.tenantId, seller.stripeAccountId); // ADR 0576 — create-only CAS
    count++;
  }
  return { sellers: count, skipped, rejected };
}

/** ADR 0576 — the reconciliation invariant: every accountIndex row must agree
 *  with its seller row. Divergence is an INCIDENT (logged + flagged), never a
 *  self-heal — a silently 'repaired' binding is exactly the rewrite this ADR
 *  forbids. Invoked from the daily sweep; exported for tests. */
export async function reconcileSellerBindings(): Promise<{ checked: number; divergent: number }> {
  let checked = 0;
  let divergent = 0;
  for (const idx of await accountIndex.list()) {
    checked++;
    const seller = await sellers.get(idx.tenantId);
    if (!seller || seller.stripeAccountId !== idx.stripeAccountId) {
      divergent++;
      log.error('seller_binding_divergence', { stripeAccountId: idx.stripeAccountId, indexTenant: idx.tenantId, sellerAccount: seller?.stripeAccountId ?? null });
    }
  }
  return { checked, divergent };
}
