/**
 * Commerce Connect — fee config, orders, destination-charge checkout, and the
 * seller-facing reads (payouts list + stats) (ADR 0385 Phases 2/3; CC-6 split).
 * Money is MAJOR-unit app-side; minor units only at the Stripe boundary, fees
 * computed minor-first (CC-9).
 */
import { OpenwopError } from '../../types.js';
import { isTombstoned } from '../../host/packTombstones.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { STRIPE_KEY_REF } from '../billing/billingService.js';
import { createStripeConnectCheckoutSession, toStripeMinorUnits, fromStripeMinorUnits } from '../billing/stripeApi.js';
import {
  orders, orderSellerIndex, paidListings, sellers, payouts, feeConfigs,
  nowIso, clampFee, DEFAULT_FEE_PCT, platformRegion, orderIdFor,
  assertFoldEligibleTenant, ENTITLED_ORDER_STATUSES,
  type ConnectOrder, type SellerPayout, type OnboardingState,
} from './stores.js';
import { listingState } from './stores.js';


/** A seller's payouts, newest first, bounded (dashboard read). */
export async function listPayouts(tenantId: string, limit = 20): Promise<SellerPayout[]> {
  return (await payouts.listForTenantIndexed(tenantId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}


/** Effective application-fee % for a seller tenant: per-tenant override →
 *  global → default; clamped at READ too so a corrupt row fails closed. */
export async function getApplicationFeePct(sellerTenantId: string): Promise<number> {
  const row = (await feeConfigs.get(sellerTenantId)) ?? (await feeConfigs.get('__global__'));
  return clampFee(row?.applicationFeePct ?? DEFAULT_FEE_PCT);
}


/** Operator (superadmin-route-gated) fee config; clamped at write. */
export async function setApplicationFeePct(key: '__global__' | (string & {}), pct: number): Promise<{ key: string; applicationFeePct: number }> {
  if (!Number.isFinite(pct)) throw new OpenwopError('validation_error', 'applicationFeePct must be a number.', 400, {});
  const applicationFeePct = clampFee(pct);
  await feeConfigs.put({ key, applicationFeePct, updatedAt: nowIso() });
  return { key, applicationFeePct };
}


export async function getOrder(orderId: string): Promise<ConnectOrder | null> {
  return orders.get(orderId);
}


/** Orders where this tenant is the buyer or the seller — both sides ride a
 *  bounded tenant-indexed read (never a full-collection scan). */
export async function listOrdersFor(tenantId: string): Promise<{ purchases: ConnectOrder[]; sales: ConnectOrder[] }> {
  const purchases = await orders.listForTenantIndexed(tenantId); // buyer-indexed
  const saleMarkers = await orderSellerIndex.listForTenantIndexed(tenantId);
  const sales = (await Promise.all(saleMarkers.map((m) => orders.get(m.orderId)))).filter((o): o is ConnectOrder => o !== null);
  const byNewest = (a: ConnectOrder, b: ConnectOrder): number => b.createdAt.localeCompare(a.createdAt);
  return { purchases: purchases.sort(byNewest), sales: sales.sort(byNewest) };
}


/** Has this buyer a PAID order for the pack (the Phase-4 delivery check seam).
 *  MPL-3 — `partially-refunded` still entitles: the buyer paid for the pack and
 *  a partial refund is a price adjustment, not a revocation. Reading the shared
 *  `ENTITLED_ORDER_STATUSES` set rather than a local literal is what keeps the
 *  grant and the revoke halves of the pair from drifting. */
export async function hasPaidOrder(buyerTenantId: string, packName: string): Promise<boolean> {
  const order = await orders.get(orderIdFor(buyerTenantId, packName));
  return order !== null && ENTITLED_ORDER_STATUSES.has(order.status);
}


export interface CheckoutStart { order: ConnectOrder; url: string; mode: 'live' | 'demo' }


/**
 * Start a destination-charge purchase of a native-paid listing. Fail-closed
 * gates in order: listing exists + native-paid + APPROVED; not self-purchase;
 * seller enabled + chargesEnabled; same-region (platform↔seller) guard; no
 * prior PAID order. The order row is CAS-inserted `pending` BEFORE the Stripe
 * call (deterministic id ⇒ a concurrent duplicate loses the CAS and reuses the
 * stored session); demo mode (keyless) returns the honest sentinel.
 */
export async function createCheckout(
  buyerTenantId: string,
  packName: string,
  urls: { successUrl: string; cancelUrl: string },
): Promise<CheckoutStart> {
  // MPL-1 / WF-MKT-13 — the GEN-CC-1 fold guard, lane 3 of 4, and the one with
  // user-visible money harm. `orderIdFor(buyerTenantId, packName)` and the
  // `orders` tenant index both key on the buyer tenant, and `hasPaidOrder` reads
  // the same key — so an anon buyer PAYS and then loses the entitlement the
  // moment the session folds into a `user:` tenant. The fold is one-way; there
  // is no recovery path once the keys are stranded, which is why this refuses
  // BEFORE the order row is minted rather than after.
  assertFoldEligibleTenant(buyerTenantId, 'buy a pack');
  const listing = await paidListings.get(packName);
  if (!listing || listing.lane !== 'native-paid') {
    throw new OpenwopError('not_found', 'No purchasable listing under that pack name.', 404, { packName });
  }
  // ADR 0574 P3 — lifecycle gate FIRST: a suspended or tombstoned listing is
  // never chargeable, whatever its approval state says.
  {
    const st = listingState(listing);
    if (st !== 'active') {
      throw new OpenwopError('conflict', st === 'suspended' ? 'This listing is under operator hold and cannot be purchased right now.' : 'This listing was dissolved by the operator.', 409, { packName, reason: 'listing_not_active', state: st });
    }
  }
  if (listing.approvalState !== 'approved') {
    throw new OpenwopError('validation_error', 'This listing is not yet approved for native purchase.', 409, { packName });
  }
  if (listing.sellerTenantId === buyerTenantId) {
    throw new OpenwopError('validation_error', 'You cannot purchase your own listing.', 409, { packName });
  }
  const seller = await sellers.get(listing.sellerTenantId);
  if (!seller || seller.onboardingState !== 'enabled' || !seller.chargesEnabled) {
    throw new OpenwopError('validation_error', 'The seller cannot take payments right now.', 409, { packName });
  }
  // UX_UPGRADE-access-data R2 (CC2-B2) — refuse to charge for a pack this host
  // has REMOVED. The browse route annotates `packMissing`, and its comment used
  // to claim "the purchase gate is the service's own approval/seller checks" —
  // but no such check existed, and nothing deletes a listing row when a pack
  // goes. An approved listing therefore stayed purchasable after removal: a live
  // Stripe charge, then an entitlement to nothing, recoverable only by a manual
  // superadmin refund.
  //
  // This gate covers TOMBSTONED only, deliberately. A tombstone is a durable,
  // explicit "removed from this host" row; ABSENCE is not the same fact.
  // `listListings()` rescans a directory that is legitimately empty in valid
  // configurations (the vitest lane isolates `OPENWOP_PACK_DIR` per worker;
  // Cloud Run pack dirs are per-instance), so refusing on absence would render a
  // failed read as an answer AND take every purchase on the host down with it.
  //
  // The absent-but-not-tombstoned half is closed at the HUMAN gate instead: the
  // approval queue now carries `packMissing`, so an operator does not approve a
  // listing for a pack this host does not have. A transient empty directory then
  // costs a warning on a review card, not an outage on the money path. See
  // `CC2-R1` in the tracker for what that still leaves open (a pack purged and
  // then restored clears its tombstone, and its listing row survives).
  if (isTombstoned(packName)) {
    throw new OpenwopError(
      'validation_error',
      'This pack has been removed from this host, so it cannot be purchased.',
      409,
      { packName, reason: 'pack_removed' },
    );
  }
  const price = listing.priceMajorUnits ?? 0;
  const currency = listing.currency ?? 'usd';
  if (!(price > 0)) throw new OpenwopError('internal_error', 'Approved native-paid listing has no price.', 500, { packName });

  const orderId = orderIdFor(buyerTenantId, packName);
  const prior = await orders.get(orderId);
  // MPL-3 (review fold-in) — the ENTITLED set, never the bare `'paid'` literal.
  // The docblock on `hasPaidOrder` states the symmetric-pair rule and this line
  // broke it two functions below. Before `partially-refunded` existed the gap was
  // harmless (every non-`paid` status meant no entitlement); this PR created the
  // first status that is ENTITLED AND NOT `paid`, and with it a durable
  // money-truth corruption reachable by the BUYER:
  //   $100 paid → seller refunds $1 → `partially-refunded` (entitlement kept).
  //   Any editor+ in the buyer tenant re-POSTs `…/purchase/checkout` (the SPA
  //   hides Buy on `purchased`, but the ROUTE is the authority and an agent/tool
  //   caller reaches it directly). The guard passed; `claim` below is built FRESH
  //   rather than spread from `prior`, so the CAS overwrote the row back to
  //   `pending` and dropped `refundedMajorUnits`, `refundRequestedAt`, `refundId`,
  //   `anomaly`, `stripePaymentIntentId` and `stripeChargeId`. Stripe's
  //   `idempotencyKey: orderId` then REPLAYED the completed session, so no new
  //   charge fired and no webhook ever arrived to repair the row. End state:
  //   `hasPaidOrder` false (the buyer loses a pack they paid for), the refund
  //   erased from the ledger, and `sellerStats` silently drops the sale because
  //   `pending` is skipped. A buyer-side action corrupting the SELLER's ledger.
  if (prior && ENTITLED_ORDER_STATUSES.has(prior.status)) {
    throw new OpenwopError('validation_error', 'This pack is already purchased for this workspace.', 409, { packName });
  }

  const key = await resolveSecret(STRIPE_KEY_REF);
  const feePct = await getApplicationFeePct(listing.sellerTenantId);
  // Grade pass CC-9: compute the fee in MINOR units first (zero-decimal aware),
  // then convert back — so the persisted ledger figure matches what Stripe is
  // actually told (a JPY fee can never be a fractional yen).
  const applicationFeeMinor = Math.round(toStripeMinorUnits(price, currency) * (feePct / 100));
  const applicationFeeMajorUnits = fromStripeMinorUnits(applicationFeeMinor, currency);
  const now = nowIso();

  if (key && seller.mode === 'live') {
    // v1 same-region restriction: destination charges platform↔seller (ADR
    // correction — NOT buyer↔seller); cross-region sellers use external links.
    if (seller.region && seller.region !== platformRegion()) {
      throw new OpenwopError('validation_error', `Native purchase is limited to ${platformRegion()}-region sellers in v1 — use the seller's external payment link.`, 409, { packName });
    }
    const claim: ConnectOrder = {
      orderId, buyerTenantId, sellerTenantId: listing.sellerTenantId, packName,
      amountMajorUnits: price, currency, applicationFeeMajorUnits,
      status: 'pending', mode: 'live', createdAt: now, updatedAt: now,
    };
    // Grade pass CC-7: honor the CAS verdict — the loser reuses the STORED row
    // (Stripe's idempotency key still returns the same session for both).
    const won = await orders.compareAndSwap(prior, claim);
    const current = won ? claim : ((await orders.get(orderId)) ?? claim);
    await orderSellerIndex.put({ orderId, sellerTenantId: listing.sellerTenantId }); // idempotent (CC-1)
    const session = await createStripeConnectCheckoutSession(key, {
      name: `Marketplace pack: ${packName}`,
      amountMinor: toStripeMinorUnits(price, currency), currency, applicationFeeMinor: applicationFeeMinor,
      destinationAccountId: seller.stripeAccountId,
      ccOrderId: orderId, idempotencyKey: orderId,
      successUrl: urls.successUrl, cancelUrl: urls.cancelUrl,
    });
    // CAS the session id in (not a blind put) — a concurrent writer that already
    // recorded it (or the webhook that already fulfilled) wins; we just re-read.
    const withSession: ConnectOrder = { ...current, stripeSessionId: session.id, updatedAt: nowIso() };
    const stamped = (await orders.compareAndSwap(current, withSession)) ? withSession : ((await orders.get(orderId)) ?? withSession);
    return { order: stamped, url: session.url, mode: 'live' };
  }

  // Demo lane — honest sentinel; the order stays pending (no money exists).
  const demo: ConnectOrder = {
    orderId, buyerTenantId, sellerTenantId: listing.sellerTenantId, packName,
    amountMajorUnits: price, currency, applicationFeeMajorUnits,
    status: 'pending', mode: 'demo', createdAt: now, updatedAt: now,
  };
  await orders.compareAndSwap(prior, demo);
  await orderSellerIndex.put({ orderId, sellerTenantId: listing.sellerTenantId });
  const order = (await orders.get(orderId)) ?? demo;
  return { order, url: `demo:checkout:${orderId}`, mode: 'demo' };
}


/** Seller-facing stats (the dashboard + the `seller-stats` node read — one
 *  bounded read per store, no cross-tenant scans). */
export async function sellerStats(tenantId: string): Promise<{
  seller: { onboardingState: OnboardingState; chargesEnabled: boolean; payoutsEnabled: boolean; region: string; mode: 'live' | 'demo' } | null;
  sales: {
    total: number; paid: number; refunded: number; disputed: number;
    grossMajorUnitsByCurrency: Record<string, number>;
    feesMajorUnitsByCurrency: Record<string, number>;
    refundedMajorUnitsByCurrency: Record<string, number>;
    netMajorUnitsByCurrency: Record<string, number>;
  };
  recentPayouts: SellerPayout[];
}> {
  const seller = await sellers.get(tenantId);
  const { sales } = await listOrdersFor(tenantId);
  // CC2-M3 (R3) — MINOR-UNITS-FIRST (the CLAUDE.md invariant). The old loop
  // summed major-unit FLOATS: 7 realistic sales measured 100.24999999999999,
  // served raw over /seller/stats AND to the seller-stats workflow node. Each
  // order converts to integer minor units, the SUM is integer arithmetic, and
  // one conversion at the end makes the major-unit wire figure exact. (The row
  // keeps `amountMajorUnits` — re-keying the store is a migration, not this
  // pass; the per-order conversion is the same one checkout already does.)
  //
  // MPL-9 / MKT-UX-4 — the POPULATION was wrong, not the arithmetic. The loop
  // admitted `paid`, `refunded` AND `disputed`, incremented a counter literally
  // named `paid`, and added the FULL amount and fee for each — so a seller whose
  // only two sales were charged back read "Paid orders 2" at full gross. The
  // arithmetic fix above (minor-units-first) was applied while the population
  // stayed wrong, which is why it survived.
  //
  // Now each state is counted and summed SEPARATELY and a net figure is derived.
  // `gross` keeps its meaning (everything ever charged, the seller's top line);
  // `refunded` is money returned; `net` is gross − refunded − disputed, which is
  // the figure a seller actually keeps. Nothing is silently folded together.
  const grossMinor: Record<string, number> = {};
  const feesMinor: Record<string, number> = {};
  const refundedMinor: Record<string, number> = {};
  const bump = (bag: Record<string, number>, c: string, m: number): void => { bag[c] = (bag[c] ?? 0) + m; };
  let paid = 0;
  let refunded = 0;
  let disputed = 0;
  for (const o of sales) {
    if (o.status === 'pending' || o.status === 'failed') continue;
    const amountMinor = toStripeMinorUnits(o.amountMajorUnits, o.currency);
    if (o.status === 'refunded') refunded++;
    else if (o.status === 'disputed') disputed++;
    else paid++; // 'paid' and 'partially-refunded' — both still entitled sales
    bump(grossMinor, o.currency, amountMinor);
    bump(feesMinor, o.currency, toStripeMinorUnits(o.applicationFeeMajorUnits, o.currency));
    // A full refund returns the whole charge; a partial returns what the webhook
    // recorded; a lost dispute takes the whole charge back. Each is money the
    // seller does not keep.
    if (o.status === 'refunded') bump(refundedMinor, o.currency, amountMinor);
    else if (o.status === 'partially-refunded') bump(refundedMinor, o.currency, toStripeMinorUnits(o.refundedMajorUnits ?? 0, o.currency));
    else if (o.status === 'disputed') bump(refundedMinor, o.currency, amountMinor);
  }
  const major = (bag: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(bag).map(([c, m]) => [c, fromStripeMinorUnits(m, c)]));
  const netMinor: Record<string, number> = {};
  for (const [c, m] of Object.entries(grossMinor)) netMinor[c] = m - (refundedMinor[c] ?? 0);
  return {
    seller: seller
      ? { onboardingState: seller.onboardingState, chargesEnabled: seller.chargesEnabled, payoutsEnabled: seller.payoutsEnabled, region: seller.region, mode: seller.mode }
      : null,
    sales: {
      total: sales.length, paid, refunded, disputed,
      grossMajorUnitsByCurrency: major(grossMinor),
      feesMajorUnitsByCurrency: major(feesMinor),
      refundedMajorUnitsByCurrency: major(refundedMinor),
      netMajorUnitsByCurrency: major(netMinor),
    },
    recentPayouts: await listPayouts(tenantId, 10),
  };
}
