/**
 * Commerce Connect — shared stores + invariant helpers (CC-6 split of the
 * former single connectService.ts; ADR 0385). This module OWNS the 11
 * `commerce-connect:*` DurableCollections (MPL-19: this said "10" while
 * `listing-tombstone` made it 11 — re-derive with
 * `grep -c "new DurableCollection" stores.ts`) and the deterministic-id / fee /
 * region helpers every domain module composes. Domain modules import ONLY this
 * module (acyclic by construction); `connectService.ts` is the stable public
 * facade — external import sites are unchanged.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { OpenwopError } from '../../types.js';
import { createHash } from 'node:crypto';
import { STRIPE_KEY_REF } from '../billing/billingService.js';



export const nowIso = (): string => new Date().toISOString();


// ── Types ─────────────────────────────────────────────────────────────────────

export type OnboardingState = 'pending' | 'restricted' | 'enabled' | 'deauthorized';


export interface SellerAccount {
  tenantId: string;
  /** Stripe Connect account id — empty string only inside the onboarding CAS
   *  claim window (released on failure, filled on success). */
  stripeAccountId: string;
  onboardingState: OnboardingState;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** ISO country — captured for the v1 same-region payout restriction (Phase 2). */
  region: string;
  capabilities: string[];
  mode: 'live' | 'demo';
  createdAt: string;
  updatedAt: string;
}


/** Reverse index row — `event.account` → seller tenant, a point lookup so the
 *  webhook path never scans the seller collection. */
export interface SellerAccountIndex { stripeAccountId: string; tenantId: string }


export interface SeenConnectEvent { key: string; processedAt: string }


const isSeller = (p: unknown): SellerAccount | null => {
  const s = p as SellerAccount;
  return s && typeof s.tenantId === 'string' && typeof s.stripeAccountId === 'string' && typeof s.onboardingState === 'string' ? s : null;
};


export const sellers = new DurableCollection<SellerAccount>('commerce-connect:seller', (s) => s.tenantId, isSeller, (s) => s.tenantId);

export const accountIndex = new DurableCollection<SellerAccountIndex>(
  'commerce-connect:seller-by-account', (r) => r.stripeAccountId, undefined, (r) => r.tenantId,
);

// DELIBERATELY NOT retention-purged and NOT tenant-indexed (the ADR 0380
// billing:webhook-event posture, adopted verbatim): this is a money-critical
// dedup ledger — purging a claim reopens the Stripe-redelivery replay window,
// rows are tiny, and the claim happens BEFORE tenant resolution so no tenantId
// exists to index by. Grade-data pass 2026-07-17 records this as accepted.
export const seenEvents = new DurableCollection<SeenConnectEvent>('commerce-connect:webhook-event', (e) => e.key);


// ── GEN-CC-1 — the `anon:` fold guard, ONE predicate for all four lanes ──────

/**
 * True when a tenant id is durable enough to key a commercial row against.
 *
 * An `anon:<sid>` tenant is the byok tenant-policy class the adopt/fold flow
 * later folds into a `user:` tenant. The fold rewrites row CONTENT but not KV row
 * KEYS, so every commerce-connect row keyed on that tenant — seller
 * (`stores.ts` `sellers`), paid listing (indexed by `sellerTenantId`), order
 * (indexed by `buyerTenantId`), and the shared `commerce-listing-publish`
 * approval row (`tenantId: sellerTenantId`) — strands permanently at fold time.
 *
 * CORRECTED 2026-08-19 (MPL-1 / WF-MKT-13). Two comments in this feature called
 * that orphan "impossible-by-construction" (`onboarding.ts` startOnboarding,
 * `adminOps.ts` importSellers). **They were wrong, and being wrong in a comment
 * is why this survived two grade passes.** The guard existed on onboarding and
 * import only — 2 of 4 lanes. It was ABSENT from `upsertPaidListing` and
 * `createCheckout`, and the route-level seller-account precondition is
 * lane-scoped (`lane === 'native-paid'`), so the `free` and `external-link`
 * lanes required no seller account at all. An anonymous session could therefore
 * publish an external-link listing carrying an arbitrary https payout URL — the
 * exact phishing/squat lane the approval gate exists for — and could complete a
 * REAL Stripe checkout whose entitlement then vanishes on sign-in, because
 * `hasPaidOrder` keys on `buyerTenantId`.
 *
 * This is the ONE predicate. Both shapes are exported because the importer
 * COUNTS AND NAMES its refusals rather than throwing on the first one.
 */
export const isFoldEligibleTenant = (tenantId: string): boolean => !tenantId.startsWith('anon:');

/** Throwing form of {@link isFoldEligibleTenant}. `action` completes the sentence
 *  "Sign in to …" so each refusal names the thing the caller was trying to do. */
export function assertFoldEligibleTenant(tenantId: string, action: string): void {
  if (!isFoldEligibleTenant(tenantId)) {
    throw new OpenwopError(
      'forbidden_scope',
      `Sign in to ${action} — anonymous sessions cannot, because the record would be lost when the session becomes an account.`,
      403,
      { feature: 'commerce-connect', reason: 'anon_tenant' },
    );
  }
}


export async function requireStripeKey(): Promise<string> {
  const key = await resolveSecret(STRIPE_KEY_REF);
  if (!key) throw new OpenwopError('credential_unavailable', 'Stripe is not configured (`billing:stripe-key`).', 503, { provider: 'stripe' });
  return key;
}


// ── Webhook handler (registered via billing's connectEventHook) ───────────────

/** The Connect event types Phase 1 applies; anything else is acked unhandled. */
export const ACCOUNT_EVENT_TYPES = new Set(['account.updated', 'capability.updated', 'account.application.deauthorized']);

/** Phase 3 — payout events are MONEY RECORDS (settled Stripe-side): applied even
 *  when the tenant's toggle is off, like purchases (the money-truth rule). */
export const PAYOUT_EVENT_TYPES = new Set(['payout.paid', 'payout.failed']);


export interface SellerPayout {
  payoutId: string;
  tenantId: string;
  amountMajorUnits: number;
  currency: string;
  status: 'paid' | 'failed';
  arrivalDate?: string;
  createdAt: string;
}


export const payouts = new DurableCollection<SellerPayout>('commerce-connect:payout', (p) => p.payoutId, undefined, (p) => p.tenantId);


// ══ Phase 2 — paid listings · fee config · destination-charge purchase ════════

export type ListingLane = 'free' | 'external-link' | 'native-paid';

export type ApprovalState = 'draft' | 'pending' | 'approved' | 'rejected';


/** Pricing metadata EXTENDING the marketplace Listing projection (ADR 0022) —
 *  never a parallel catalog: browse/install/review state stays in
 *  `marketplace/listingService`; this row only adds lane + price + approval. */
/** ADR 0574 P3 — the listing lifecycle. Absent ⇒ 'active' (additive; every
 *  pre-0574 row is active). 'suspended' = operator hold (visible to the
 *  seller, never purchasable, not a 404 — the intermediate state a dispute
 *  needs). 'tombstoned' = operator-dissolved (ADR 0574 P1). */
export type ListingState = 'active' | 'suspended' | 'tombstoned';

export interface PaidListing {
  packName: string;
  sellerTenantId: string;
  lane: ListingLane;
  priceMajorUnits?: number;
  currency?: string;
  externalPaymentUrl?: string;
  /** Native-paid gate (Notion model): purchasable ONLY when 'approved'. */
  approvalState?: ApprovalState;
  /**
   * MKT-UX-7 — the operator's REASON for the decision, mirrored onto the listing
   * so the SELLER can read it.
   *
   * "Rejected" used to be the entire feedback a seller got: no reason, no note,
   * no date, no "what to do next" — and it was not a UI-only gap, because the
   * decide route parsed `{ decision }` only, so the reason did not exist anywhere
   * in the system. The `resolveApproval` core already accepted a `note`; the
   * route simply never populated it. The note lives on the approval row (the
   * audit) AND here (the seller's read), because a seller cannot read approval
   * rows — they read `/seller/listings`.
   */
  approvalNote?: string;
  approvalDecidedAt?: string;
  /** ADR 0574 P3 — lifecycle state; absent ⇒ 'active'. */
  state?: ListingState;
  /** Set when state !== 'active' — who/when/why (the audit the row carries). */
  stateMeta?: { by: string; at: string; reason: string };
  createdAt: string;
  updatedAt: string;
}

/** ADR 0574 P1 — the DURABLE tombstone audit row. Survives re-claims of the
 *  name (the listing row is keyed by packName and gets overwritten by a new
 *  claim; this row is what the 90-day same-seller cooldown checks). */
export interface ListingTombstone {
  /** `${packName}` — one row per name, latest dissolution wins. */
  packName: string;
  sellerTenantId: string;
  by: string;
  at: string;
  reason: string;
}


/**
 * MPL-3 — `partially-refunded` is a FIRST-CLASS terminal-ish state, not a
 * cosmetic label.
 *
 * `charge.refunded` fires for PARTIAL refunds too, and `stripeApi.createStripeRefund`
 * already supports `amountMinor`, so partials are a shape this codebase produces.
 * The handler used to flip the whole order to `refunded` on any such event without
 * reading `amount_refunded` (zero occurrences backend-wide before this change) — so
 * a $1 goodwill refund on a $100 pack revoked the buyer's entitlement entirely
 * (`hasPaidOrder` returns false for anything but `paid`) AND recorded a full return
 * in the money-truth ledger. `partially-refunded` keeps the entitlement and records
 * the actual amount; the terminal `refunded` is reserved for a full return.
 */
export type OrderStatus = 'pending' | 'paid' | 'partially-refunded' | 'refunded' | 'disputed' | 'failed';

/** The order statuses that still carry an entitlement (`hasPaidOrder`). A partial
 *  refund does NOT revoke the pack — the buyer paid for and still holds it. */
export const ENTITLED_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['paid', 'partially-refunded']);


export interface ConnectOrder {
  orderId: string;
  buyerTenantId: string;
  sellerTenantId: string;
  packName: string;
  amountMajorUnits: number;
  currency: string;
  applicationFeeMajorUnits: number;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  status: OrderStatus;
  /** MPL-3 — the CUMULATIVE amount returned to the buyer, from Stripe's
   *  `charge.amount_refunded` (which is itself cumulative, so a second partial
   *  refund overwrites rather than adds — never `+=` here). */
  refundedMajorUnits?: number;
  /** MPL-4 — stamped when the operator ISSUES a refund, so the window between
   *  the API call and the `charge.refunded` webhook is VISIBLE rather than
   *  indistinguishable from "no refund was ever requested". */
  refundRequestedAt?: string;
  refundId?: string;
  /**
   * MPL-5 — a money anomaly that reached this order row and was NOT applied.
   * Set on the amount-mismatch branch of the purchase handler, which returns
   * `handled: true` (correct — a Stripe retry cannot help) but leaves the order
   * `pending` with money captured. Read by `exceptionSources.ts`; the log line
   * alone was the only trace before.
   */
  anomaly?: { kind: 'purchase-amount-mismatch' | 'refund-amount-missing'; at: string; detail: string };
  mode: 'live' | 'demo';
  createdAt: string;
  updatedAt: string;
}


export interface FeeConfig { key: string; applicationFeePct: number; updatedAt: string }


export const paidListings = new DurableCollection<PaidListing>('commerce-connect:paid-listing', (l) => l.packName, undefined, (l) => l.sellerTenantId);
// MPL-7 — TENANT-INDEXED, and this one was reachable by NOTHING. It had no
// `tenantOf`, and its row type has no field literally named `tenantId`, so
// `purgeTenantRows`'s `jsonTenantId` fallback skipped it too: no eraser, no
// purger, and no tenant teardown, while the row carries a raw `req.userId` in
// `by` and operator free text in `reason`. Every dissolution added a row that no
// mechanism in the app could ever remove.
export const listingTombstones = new DurableCollection<ListingTombstone>('commerce-connect:listing-tombstone', (t) => t.packName, undefined, (t) => t.sellerTenantId);

/** ADR 0574 P3 — the ONE lifecycle read. Absent ⇒ active. */
export const listingState = (l: PaidListing): ListingState => l.state ?? 'active';

/** ADR 0576 — the binding invariant: a stripeAccountId binds to AT MOST ONE
 *  tenant, immutable except explicit dissolution. Every accountIndex write goes
 *  through here (import AND onboarding); a put that would CHANGE the tenant of
 *  an existing binding throws `binding_conflict` instead of silently
 *  re-routing that account's webhook attribution. Same-tenant re-put is the
 *  idempotent no-op onboarding needs. */
export async function bindSellerAccount(tenantId: string, stripeAccountId: string): Promise<void> {
  const existing = await accountIndex.get(stripeAccountId);
  if (existing && existing.tenantId !== tenantId) {
    throw new OpenwopError('conflict', 'This Stripe account is already bound to another workspace. Dissolve the existing binding first.', 409, { stripeAccountId, reason: 'binding_conflict' });
  }
  if (!existing) await accountIndex.put({ stripeAccountId, tenantId });
}

export const orders = new DurableCollection<ConnectOrder>('commerce-connect:order', (o) => o.orderId, undefined, (o) => o.buyerTenantId);

/** Seller-side order index (orders are buyer-tenant-indexed; a seller's sales
 *  view must not be a full-collection scan — the host_ext_kv lesson). */
export const orderSellerIndex = new DurableCollection<{ orderId: string; sellerTenantId: string }>(
  'commerce-connect:order-by-seller', (r) => r.orderId, undefined, (r) => r.sellerTenantId,
);

// Grade-data DATA-CC-1: tenant-indexed so a PER-TENANT fee override is purged by
// tenant teardown (ADR 0284 registry). The '__global__' row registers under a
// pseudo-tenant slice that no teardown ever targets — harmless by construction.
export const feeConfigs = new DurableCollection<FeeConfig>('commerce-connect:fee-config', (f) => f.key, undefined, (f) => f.key);


/** ADR 0385 bounds; default = the midpoint (final % is ADR open question 2). */
const FEE_MIN_PCT = 10;

const FEE_MAX_PCT = 15;

export const DEFAULT_FEE_PCT = 12;

export const clampFee = (pct: number): number => Math.min(FEE_MAX_PCT, Math.max(FEE_MIN_PCT, pct));


/** The platform Stripe account's region — the v1 same-region payout restriction
 *  is PLATFORM↔seller (destination charges; ADR correction note), not
 *  buyer↔seller. */
export function platformRegion(): string {
  return (process.env.OPENWOP_CONNECT_PLATFORM_REGION ?? 'US').toUpperCase();
}


/** Deterministic order id — one license per (buyer, pack); a fork/replay or a
 *  double-click derives the SAME id, so Stripe's Idempotency-Key and the CAS
 *  insert both dedupe instead of double-charging (ADR matrix row 9). */
export function orderIdFor(buyerTenantId: string, packName: string): string {
  return `cco_${createHash('sha256').update(`${buyerTenantId}|${packName}`).digest('hex').slice(0, 32)}`;
}


/** The purchase-success event types the handler applies. */
export const PURCHASE_EVENT_TYPES = new Set(['checkout.session.completed', 'payment_intent.succeeded']);


// ══ Phase 5 — refunds · disputes · platform-loss ledger · importer ════════════

export interface ConnectDispute {
  disputeId: string;
  orderId?: string;
  sellerTenantId: string;
  amountMajorUnits: number;
  currency: string;
  reason?: string;
  status: 'open' | 'won' | 'lost';
  /** The platform's realized loss (destination-charge liability) — set when lost. */
  platformLossMajorUnits: number;
  createdAt: string;
  updatedAt: string;
}


export const disputes = new DurableCollection<ConnectDispute>('commerce-connect:dispute', (d) => d.disputeId, undefined, (d) => d.sellerTenantId);

/** payment-intent → order index (Dispute objects carry no metadata; this is the
 *  only way to attribute one). Written at fulfilment. */
export const orderIntentIndex = new DurableCollection<{ paymentIntentId: string; orderId: string; tenantId: string }>(
  'commerce-connect:order-by-intent', (r) => r.paymentIntentId, undefined, (r) => r.tenantId,
);


/** Test-only: reset the commerce-connect stores. */
export async function __resetCommerceConnect(): Promise<void> {
  for (const s of await sellers.list()) await sellers.delete(s.tenantId);
  for (const r of await accountIndex.list()) await accountIndex.delete(r.stripeAccountId);
  for (const e of await seenEvents.list()) await seenEvents.delete(e.key);
  for (const l of await paidListings.list()) await paidListings.delete(l.packName);
  for (const o of await orders.list()) await orders.delete(o.orderId);
  for (const i of await orderSellerIndex.list()) await orderSellerIndex.delete(i.orderId);
  for (const f of await feeConfigs.list()) await feeConfigs.delete(f.key);
  for (const p of await payouts.list()) await payouts.delete(p.payoutId);
  for (const d of await disputes.list()) await disputes.delete(d.disputeId);
  for (const r of await orderIntentIndex.list()) await orderIntentIndex.delete(r.paymentIntentId);
  // MPL-17 — the ELEVENTH store. Omitting it left the 90-day same-seller
  // dissolution cooldown row behind for every later test in the same worker,
  // a same-worker cross-test coupling in a money feature.
  for (const t of await listingTombstones.list()) await listingTombstones.delete(t.packName);
}
