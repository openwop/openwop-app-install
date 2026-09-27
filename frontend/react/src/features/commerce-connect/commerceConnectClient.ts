/**
 * Commerce Connect API client (ADR 0385 Phase 1) — seller onboarding + account
 * state against the host-ext routes.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const root = `${config.baseUrl}/host/openwop-app/commerce-connect`;

export type OnboardingState = 'pending' | 'restricted' | 'enabled' | 'deauthorized';

export interface SellerAccount {
  tenantId: string;
  stripeAccountId: string;
  onboardingState: OnboardingState;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  region: string;
  capabilities: string[];
  mode: 'live' | 'demo';
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingStart { seller: SellerAccount; url: string; mode: 'live' | 'demo' }

/** API error carrying the HTTP status so callers can distinguish "not allowed"
 *  (403 → hide the surface) from a transient failure (→ designed error state,
 *  grade-pass UX-CC-1). */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'ApiError'; }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* body not json */ }
    throw new ApiError(detail || `${ctx} returned ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export async function getSellerAccount(): Promise<SellerAccount | null> {
  const out = await asJson<{ seller: SellerAccount | null }>(
    await fetch(`${root}/seller`, fetchOpts({ headers: authedHeaders() })), 'seller',
  );
  return out.seller;
}

export async function startOnboarding(): Promise<OnboardingStart> {
  return asJson(
    await fetch(`${root}/seller/onboard`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({}) })),
    'onboard',
  );
}

export interface SellerPayout {
  payoutId: string;
  amountMajorUnits: number;
  currency: string;
  status: 'paid' | 'failed';
  arrivalDate?: string;
  createdAt: string;
}

export interface SellerStats {
  seller: Pick<SellerAccount, 'onboardingState' | 'chargesEnabled' | 'payoutsEnabled' | 'region' | 'mode'> | null;
  /** MPL-9 / MKT-UX-4 — `paid` used to include REFUNDED and DISPUTED orders at
   *  full gross and full fee, so a seller with two chargebacks read "Paid orders
   *  2 · Gross 80". Each state is now its own count, and `net` is what the seller
   *  actually kept. The fields are REQUIRED, not optional: an optional field with
   *  a `?? 0` fallback in the card is how a dropped wire field turns back into
   *  the original overstatement instead of a compile error. */
  sales: {
    total: number; paid: number; refunded: number; disputed: number;
    grossMajorUnitsByCurrency: Record<string, number>;
    feesMajorUnitsByCurrency: Record<string, number>;
    refundedMajorUnitsByCurrency: Record<string, number>;
    netMajorUnitsByCurrency: Record<string, number>;
  };
  recentPayouts: SellerPayout[];
}

export async function getSellerStats(): Promise<SellerStats> {
  return asJson(await fetch(`${root}/seller/stats`, fetchOpts({ headers: authedHeaders() })), 'stats');
}

export type ListingLane = 'free' | 'external-link' | 'native-paid';

export interface PaidListing {
  packName: string;
  sellerTenantId: string;
  lane: ListingLane;
  priceMajorUnits?: number;
  currency?: string;
  externalPaymentUrl?: string;
  approvalState?: 'draft' | 'pending' | 'approved' | 'rejected';
  /** MKT-UX-7 — the operator's reason. "Rejected" used to be the ENTIRE feedback
   *  and the reason did not exist anywhere on the wire. */
  approvalNote?: string;
  approvalDecidedAt?: string;
  /** MPL-11 — ADR 0574 P3 defines `suspended` as "visible to the seller, never
   *  purchasable, not a 404". This type omitted `state` entirely, so the card
   *  rendered a held listing identically to a live one and the seller saw a
   *  normal listing that silently could not be bought — precisely the state the
   *  ADR added to AVOID. */
  state?: 'active' | 'suspended' | 'tombstoned';
  stateMeta?: { by: string; at: string; reason: string };
  createdAt: string;
  updatedAt: string;
}

export async function listOwnListings(): Promise<PaidListing[]> {
  const out = await asJson<{ listings: PaidListing[] }>(
    await fetch(`${root}/seller/listings`, fetchOpts({ headers: authedHeaders() })), 'listings',
  );
  return out.listings;
}

export async function upsertListing(packName: string, input: { lane: ListingLane; priceMajorUnits?: number; currency?: string; externalPaymentUrl?: string }): Promise<PaidListing> {
  const out = await asJson<{ listing: PaidListing }>(
    await fetch(`${root}/listings/${encodeURIComponent(packName)}`, fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(input) })),
    'upsert-listing',
  );
  return out.listing;
}

/** MPL-6 / MKT-UX-17 — release your OWN listing. Until this existed the only
 *  removal was the superadmin dissolution, which tombstones and imposes a 90-day
 *  cooldown, so a listing was effectively permanent from the seller's side. */
export async function releaseListing(packName: string): Promise<void> {
  const res = await fetch(`${root}/listings/${encodeURIComponent(packName)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* not json */ }
    throw new ApiError(detail || `release-listing returned ${res.status}`, res.status);
  }
}

/** A pending operator listing-approval row (chat-first-port F3) — the SHARED
 *  `commerce-listing-publish` approval, projected for the operator queue card. */
export interface PendingListingApproval {
  approvalId: string;
  packName: string;
  lane: ListingLane;
  proposal: string;
  createdAt: string;
  priceMajorUnits?: number;
  currency?: string;
  /** CC2-B1 — the two facts the approval decision actually turns on. REQUIRED
   *  (not optional) for the seller: an optional field with a `?? ''` fallback in
   *  the card is how a dropped wire field turns back into the original defect —
   *  the operator seeing a listing with no attributable submitter — instead of
   *  a compile error. */
  sellerTenantId: string;
  /** The payout destination on the `external-link` lane. Absent on native-paid,
   *  where money moves through the platform's own Stripe account. */
  externalPaymentUrl?: string;
  /** CC2-R1 — this host has no such pack (uninstalled, purged, or tombstoned).
   *  The MONEY path refuses only a tombstoned pack, because absence is ambiguous
   *  and refusing on it would take purchases down whenever the pack directory is
   *  briefly unreadable. Approving is the safe place to be cautious instead. */
  packMissing: boolean;
}

/** Superadmin-only (403 hides the queue in the UI — backend is the authority). */
export async function listApprovals(): Promise<PendingListingApproval[]> {
  const out = await asJson<{ pending: PendingListingApproval[] }>(
    await fetch(`${root}/approvals`, fetchOpts({ headers: authedHeaders() })), 'approvals',
  );
  return out.pending;
}

/** Resolve the shared approval row (chat-first-port F3) — decides by approvalId,
 *  routed through the shared decision core on the backend.
 *
 *  MKT-UX-7 — `reason` is REQUIRED by the backend on a rejection and is mirrored
 *  onto the seller's listing row. It is typed as required-on-reject here rather
 *  than optional so a caller cannot omit it and rediscover the dead end. */
export async function decideApproval(approvalId: string, decision: 'approved', reason?: string): Promise<void>;
export async function decideApproval(approvalId: string, decision: 'rejected', reason: string): Promise<void>;
export async function decideApproval(approvalId: string, decision: 'approved' | 'rejected', reason?: string): Promise<void> {
  await asJson<{ approvalId: string; status: string }>(
    await fetch(`${root}/approvals/${encodeURIComponent(approvalId)}`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }) })),
    'decide-approval',
  );
}

export interface ConnectOrder {
  orderId: string;
  buyerTenantId: string;
  sellerTenantId: string;
  packName: string;
  amountMajorUnits: number;
  currency: string;
  applicationFeeMajorUnits: number;
  /** MPL-3 — `partially-refunded` keeps the entitlement; the terminal `refunded`
   *  revokes it. Rendering the two identically is what made a $1 goodwill refund
   *  read as a full return. */
  status: 'pending' | 'paid' | 'partially-refunded' | 'refunded' | 'disputed' | 'failed';
  refundedMajorUnits?: number;
  /** MPL-4 — set when the operator ISSUED a refund. Present with `status: 'paid'`
   *  means the Stripe confirmation has not landed yet: the row must NOT offer
   *  Refund again as if nothing had happened. */
  refundRequestedAt?: string;
  mode: 'live' | 'demo';
  createdAt: string;
}

export interface ConnectDispute {
  disputeId: string;
  orderId?: string;
  sellerTenantId: string;
  amountMajorUnits: number;
  currency: string;
  reason?: string;
  status: 'open' | 'won' | 'lost';
  platformLossMajorUnits: number;
  createdAt: string;
}

/** Superadmin-only admin console reads (403 hides the card). */
export async function listAdminOrders(): Promise<ConnectOrder[]> {
  const out = await asJson<{ orders: ConnectOrder[] }>(
    await fetch(`${root}/admin/orders`, fetchOpts({ headers: authedHeaders() })), 'admin-orders',
  );
  return out.orders;
}

export async function listAdminDisputes(): Promise<{ disputes: ConnectDispute[]; platformLossMajorUnitsByCurrency: Record<string, number> }> {
  return asJson(await fetch(`${root}/admin/disputes`, fetchOpts({ headers: authedHeaders() })), 'admin-disputes');
}

/** MPL-4 — the response distinguishes a refund this call APPLIED (demo lane)
 *  from one it merely INITIATED (live lane: the flip rides `charge.refunded`).
 *  The SPA used to render both as plain success, which is why the operator was
 *  invited to fire again at a row still reading Paid. */
export async function refundAdminOrder(orderId: string): Promise<{ refundId?: string; applied: boolean; state: 'applied' | 'initiated'; order: ConnectOrder }> {
  return asJson(
    await fetch(`${root}/admin/orders/${encodeURIComponent(orderId)}/refund`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({}) })),
    'refund',
  );
}

export async function syncSellerAccount(): Promise<SellerAccount> {
  const out = await asJson<{ seller: SellerAccount }>(
    await fetch(`${root}/seller/sync`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({}) })),
    'sync',
  );
  return out.seller;
}
