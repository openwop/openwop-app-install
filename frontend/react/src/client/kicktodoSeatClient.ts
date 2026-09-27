/**
 * KickTodo cohort-seat FE client (ADR 0431 P4) — React-free over the seat
 * routes on `/host/openwop-app/kicktodo/entitlements/cohort-seats/*`.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const ENTITLEMENTS_BASE = `${config.baseUrl}/host/openwop-app/kicktodo/entitlements`;
const BASE = `${ENTITLEMENTS_BASE}/cohort-seats`;

/** Per-product entitlement counts for the CALLER's OWN products (ADR 0420
 *  `revenueProjectionFor`): the creator-facing signal — counts only, never buyer
 *  PII/subjects. Self-data, so no k-anonymity floor applies. */
export interface CreatorRevenueRow {
  productId: string;
  challengeId: string;
  challengeVersion: number;
  activeEntitlements: number;
  revokedEntitlements: number;
}

/** The creator's own products' entitlement counts (ADR 0437 UX-2.7). Subject-scoped
 *  server-side — the caller only ever sees their own products. */
export async function getMyRevenue(): Promise<CreatorRevenueRow[]> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/revenue`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`revenue failed: ${res.status}`);
  return ((await res.json()) as { revenue: CreatorRevenueRow[] }).revenue;
}

/** Operator reconciliation (ADR 0438 A5 / KTFULL-B13): re-grants entitlements for
 *  paid-but-unfulfilled orders (fulfilment observers are best-effort by design).
 *  Admin-scoped (`requireKicktodoManage`) + idempotent — a healthy tenant repairs
 *  zero. Returns what it scanned and repaired. */
export async function reconcileCommerce(): Promise<{ ordersScanned: number; entitlementsRepaired: number }> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/reconcile`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
  });
  if (!res.ok) throw new Error(`reconcile failed: ${res.status}`);
  return (await res.json()) as { ordersScanned: number; entitlementsRepaired: number };
}

export interface ReferralEarnings { code: string | null; balanceOwed: number; currency: string }

/** ADR 0451 P3 — the caller's OWN referral commission owed (a ledger projection;
 *  advisory). `code: null` ⇒ they've never referred; any failure ⇒ null code so
 *  the surface simply omits the referral figure rather than breaking Insights. */
export async function getReferralEarnings(): Promise<ReferralEarnings> {
  try {
    const res = await fetch(`${ENTITLEMENTS_BASE}/referral-earnings`, { ...fetchOpts({}), headers: authedHeaders({}) });
    if (!res.ok) return { code: null, balanceOwed: 0, currency: 'USD' };
    return (await res.json()) as ReferralEarnings;
  } catch {
    return { code: null, balanceOwed: 0, currency: 'USD' };
  }
}

/** ADR 0445 P1 — one author share-ledger row: REAL currency in minor units,
 *  derived from paid-order truth. `reversal` rows carry negative amounts. */
export interface ShareLedgerRow {
  orderId: string;
  challengeId: string;
  kind: 'accrual' | 'reversal';
  currency: string;
  shareMinor: number;
  state: 'accrued' | 'paid';
  createdAt: string;
}

export interface EarningsTotal { currency: string; accruedMinor: number; paidMinor: number }

/** The caller's OWN earnings (self-scoped server-side): ledger rows + per-currency
 *  accrued/paid totals. `accrued` is honestly UNPAID until a payout run. */
export async function getMyEarnings(): Promise<{ rows: ShareLedgerRow[]; totals: EarningsTotal[] }> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/my-earnings`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`earnings failed: ${res.status}`);
  return (await res.json()) as { rows: ShareLedgerRow[]; totals: EarningsTotal[] };
}

export interface SellerOnboardingStatus {
  request: 'none' | 'pending' | 'approved' | 'rejected';
  seller: { onboardingState: string; payoutsEnabled: boolean } | null;
}

/** ADR 0445 P2 — the author's payout-onboarding request state + the tenant's
 *  Connect seller state (the honest "when do I actually get paid" read). */
export async function getSellerOnboardingStatus(): Promise<SellerOnboardingStatus> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/seller-onboarding/status`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`seller status failed: ${res.status}`);
  return (await res.json()) as SellerOnboardingStatus;
}

/** Request payout onboarding: ONE `connect-seller` approval on the shared
 *  operator queue (seller lanes are approval-gated). Idempotent per author. */
export async function requestSellerOnboarding(): Promise<{ approvalId: string }> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/seller-onboarding/request`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
  });
  if (!res.ok) throw new Error(`seller request failed: ${res.status}`);
  return (await res.json()) as { approvalId: string };
}

/** ADR 0445 P4 — statement download URLs (cookie-authed `<a download>` targets;
 *  the ADR 0297 D2 audit-export pattern — the ledger as a file). */
export const earningsCsvUrl = `${ENTITLEMENTS_BASE}/my-earnings.csv`;
export const shareLedgerCsvUrl = `${ENTITLEMENTS_BASE}/share-ledger.csv`;

// ── ADR 0445 P3 — payout runs (operator records; the host never moves money) ──

export interface PayoutRunEntry { authorSubject: string; currency: string; totalMinor: number; rowCount: number }
export interface PayoutRun {
  runId: string;
  state: 'open' | 'confirmed' | 'canceled';
  entries: PayoutRunEntry[];
  createdAt: string;
  reference?: string;
}

export interface SharePolicy { shareBps: number; version: number }

/** The tenant author-share policy (operator read; null = no policy ⇒ no accrual). */
export async function getSharePolicy(): Promise<SharePolicy | null> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/share-policy`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`share policy failed: ${res.status}`);
  return ((await res.json()) as { policy: SharePolicy | null }).policy;
}

export async function setSharePolicy(shareBps: number): Promise<SharePolicy> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/share-policy`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ shareBps }),
  });
  if (!res.ok) throw new Error(`share policy set failed: ${res.status}`);
  return ((await res.json()) as { policy: SharePolicy }).policy;
}

export async function listPayoutRuns(): Promise<PayoutRun[]> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/payout-runs`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`payout runs failed: ${res.status}`);
  return ((await res.json()) as { runs: PayoutRun[] }).runs;
}

/** Open a run: CAS-claims every unclaimed accrued row (net-positive authors).
 *  409/400 when there is nothing accrued. */
export async function createPayoutRun(): Promise<PayoutRun | null> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/payout-runs`, {
    ...fetchOpts({}), method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }),
  });
  if (res.status === 400) return null; // nothing accrued — an honest no-op
  if (!res.ok) throw new Error(`payout run failed: ${res.status}`);
  return ((await res.json()) as { run: PayoutRun }).run;
}

/** Confirm the EXTERNAL payment happened (reference = observed Connect payout
 *  id / operator note) — only then do ledger rows flip accrued→paid. */
export async function confirmPayoutRun(runId: string, reference: string): Promise<PayoutRun> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/payout-runs/confirm`, {
    ...fetchOpts({}), method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ runId, reference }),
  });
  if (!res.ok) throw new Error(`payout confirm failed: ${res.status}`);
  return ((await res.json()) as { run: PayoutRun }).run;
}

export async function cancelPayoutRun(runId: string): Promise<PayoutRun> {
  const res = await fetch(`${ENTITLEMENTS_BASE}/payout-runs/cancel`, {
    ...fetchOpts({}), method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ runId }),
  });
  if (!res.ok) throw new Error(`payout cancel failed: ${res.status}`);
  return ((await res.json()) as { run: PayoutRun }).run;
}

const CIRCLES_BASE = `${config.baseUrl}/host/openwop-app/circles`;

/**
 * KTUX-6 / KTFULL-B12 — operator seat reconciliation for a cohort. Recomputes
 * `seatsTaken` from durable truth (admin-scoped, idempotent). Returns the
 * POST-STATE, deliberately with NO delta: the route cannot honestly say "N
 * repaired", so the caller renders "seats now N of M". Same `fetchOpts` +
 * `authedHeaders` as every other seat call (the KTUX-1 auth-cookie discipline).
 */
export async function reconcileSeats(circleId: string): Promise<{ circleId: string; seatsTaken: number; capacity: number }> {
  const res = await fetch(`${CIRCLES_BASE}/${encodeURIComponent(circleId)}/reconcile-seats`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
  });
  if (!res.ok) throw new Error(`reconcile-seats failed: ${res.status}`);
  return (await res.json()) as { circleId: string; seatsTaken: number; capacity: number };
}

export interface SeatAvailability {
  capacity: number;
  seatsTaken: number;
  seatsLeft: number;
  heldByYou: boolean;
  holdExpiresAt?: string;
  challengeTitle: string;
  /** §5.10 — the id behind the title, for the challenge back-link. */
  challengeId: string;
  startDateLocal: string;
  /** G4 — the product's owning org, for the `/store/:orgId` checkout deep-link. */
  orgId?: string;
}

export async function getSeatAvailability(productId: string): Promise<SeatAvailability | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(productId)}`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`seat availability failed: ${res.status}`);
  return (await res.json()) as SeatAvailability;
}

/** Reserve a seat BEFORE checkout — a held seat is an occupied seat, so two
 *  buyers cannot both be sold the last one. Returns false when it is full. */
export async function reserveSeat(productId: string): Promise<boolean> {
  const res = await fetch(`${BASE}/hold`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ productId }),
  });
  if (res.status === 409) return false; // full
  if (!res.ok) throw new Error(`reserve failed: ${res.status}`);
  return true;
}
