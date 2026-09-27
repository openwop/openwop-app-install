/**
 * Commerce affiliates / commission / payout (ADR 0177 deferred P5 → ADR 0447 P2).
 *
 * The commission lane now rides the host obligation ledger — the same machine
 * as KickTodo author shares — instead of a mutable running balance. What that
 * buys (each was a live defect class of the old `balanceOwed` model):
 *
 *  - per-order accrual ROWS (audit: every cent traceable to an order), integer
 *    minor units — no float `round2` drift;
 *  - REFUND CLAWBACK via mirror-negated reversals (the old lane never clawed
 *    back a refunded order's commission);
 *  - payout = a payee-scoped ledger RUN (CAS-claimed; two concurrent payouts
 *    can never both claim the balance — the M5b race is gone by construction,
 *    and M5a's lost-accrual CAS contention is gone because accruals are
 *    independent rows, not increments).
 *
 * CONTRACT COMPATIBILITY (test/FE-pinned, kept exactly):
 *  - `Affiliate.balanceOwed` on reads is now a PROJECTION: the affiliate's
 *    accrued ledger net, minor→major. The stored field is FROZEN (backfilled
 *    into an opening-balance row at boot; never written again; deleted in P3).
 *  - `recordPayout` still returns a `Payout` row (`status: 'pending'` —
 *    advisory; disbursement stays operator last-mile) and still 409s
 *    'No balance owed.' when nothing is accrued. The legacy `commerce:payout`
 *    row is written as the compat surface; the LEDGER RUN (confirmed with an
 *    `advisory:` reference) is the truth.
 *  - The lane stays advisory: no money movement anywhere (the ledger law).
 *
 * @see docs/adr/0447-obligation-ledger-unification.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import {
  createObligationLedger,
  summarizeObligations,
  ObligationRunError,
} from '../../host/obligationLedger.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { toStripeMinorUnits, fromStripeMinorUnits } from '../billing/stripeApi.js';
import { recordCommerceAction } from './telemetry.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.commerce.affiliate');
const nowIso = (): string => new Date().toISOString();

export type CommissionType = 'percentage' | 'fixed';
export interface Affiliate {
  affiliateId: string; tenantId: string; orgId: string;
  code: string; name: string;
  commissionType: CommissionType; commissionRate: number; // percentage: 0..100; fixed: amount per order
  /** READ-TIME PROJECTION of the accrued ledger net (major units). The stored
   *  value is frozen post-backfill and ignored by every read (ADR 0447 P2). */
  balanceOwed: number; currency: string;
  createdAt: string; updatedAt: string;
}
export interface Payout { payoutId: string; tenantId: string; orgId: string; affiliateId: string; amount: number; currency: string; status: 'pending' | 'paid'; createdAt: string }

const affiliates = new DurableCollection<Affiliate>('commerce:affiliate', (a) => a.affiliateId, undefined, (a) => a.tenantId);
const payouts = new DurableCollection<Payout>('commerce:payout', (p) => p.payoutId, undefined, (p) => p.tenantId);

const ledger = createObligationLedger({
  ns: 'commerce:affiliate-ledger',
  runsNs: 'commerce:affiliate-payout-runs',
  logComponent: 'commerce.affiliate.ledger',
});

/**
 * ADR 0451 P2 — an accrual-guard seam (core-defines-seam / feature-registers,
 * the `notificationPolicy` pattern). A feature can veto a single commission
 * accrual — e.g. KickTodo refusing a self-referral (a buyer using their OWN
 * referral code), which the shared affiliate lane can't detect because
 * `Affiliate` has no owner column. Fail-OPEN: a guard that throws never strands
 * legitimate commission (money is advisory here; the operator reviews payouts).
 */
export interface AccrualGuardOrder {
  tenantId: string;
  orgId: string;
  orderId: string;
  createdBy?: string;
  /** The order's linked CRM contact (present on a guest/public checkout, where
   *  `createdBy` is a `public:` sentinel) — lets a guard match a self-referral by
   *  identity even when the buyer isn't an authenticated subject (ADR 0451 P2b). */
  contactId?: string;
  affiliateCode?: string;
}
type AccrualGuard = (order: AccrualGuardOrder) => Promise<boolean>;
const accrualGuards: AccrualGuard[] = [];
/** Register a veto guard consulted before every commission accrual (return false to skip). */
export function registerAffiliateAccrualGuard(fn: AccrualGuard): void {
  accrualGuards.push(fn);
}
/** Test-only: clear registered accrual guards. */
export function __resetAccrualGuards(): void {
  accrualGuards.length = 0;
}

/** The affiliate's live owed balance: accrued ledger net, minor units. */
async function accruedNetMinor(tenantId: string, affiliateId: string): Promise<number> {
  const rows = await ledger.listForPayee(tenantId, affiliateId);
  return summarizeObligations(rows).reduce((s, c) => s + c.accruedMinor, 0);
}

/** Project the frozen row into the read contract (balanceOwed from the ledger). */
async function projectAffiliate(a: Affiliate): Promise<Affiliate> {
  return { ...a, balanceOwed: fromStripeMinorUnits(await accruedNetMinor(a.tenantId, a.affiliateId), a.currency) };
}

export async function listAffiliates(tenantId: string, orgId: string): Promise<Affiliate[]> {
  const raw = (await affiliates.listForTenantIndexed(tenantId)).filter((a) => a.orgId === orgId);
  return Promise.all(raw.map(projectAffiliate));
}

/** Grade fix (2026-07-20 HIGH-1) — the NON-projecting lookup for hot paths.
 *  Projection is one full ledger scan PER affiliate; the paid-order accrual
 *  path, the public checkout ref-capture, and the dup-code check only need
 *  code/rate/currency/id, so they must never pay O(affiliates × ledger).
 *  `balanceOwed` here is the FROZEN stored value — meaningless post-P2; every
 *  human-facing read (list/export/byCode) stays projected. */
async function findAffiliateRaw(tenantId: string, orgId: string, code: string): Promise<Affiliate | null> {
  const up = code.trim().toUpperCase();
  return (await affiliates.listForTenantIndexed(tenantId)).find((a) => a.orgId === orgId && a.code === up) ?? null;
}

/** Existence/attribution probe for the PUBLIC checkout ref-capture (hot,
 *  unauthenticated) — never projects, never leaks more than the code. */
export async function affiliateCodeExists(tenantId: string, orgId: string, code: string): Promise<string | null> {
  return (await findAffiliateRaw(tenantId, orgId, code))?.code ?? null;
}

export async function affiliateByCode(tenantId: string, orgId: string, code: string): Promise<Affiliate | null> {
  const raw = await findAffiliateRaw(tenantId, orgId, code);
  return raw ? projectAffiliate(raw) : null;
}
export async function createAffiliate(input: { tenantId: string; orgId: string; code: unknown; name?: unknown; commissionType: unknown; commissionRate: unknown; currency?: unknown }): Promise<Affiliate> {
  const code = cleanString(input.code, 60).toUpperCase();
  if (!code) throw new OpenwopError('validation_error', 'An affiliate `code` is required.', 400, {});
  if (await findAffiliateRaw(input.tenantId, input.orgId, code)) throw new OpenwopError('validation_error', 'That affiliate code already exists.', 409, { code });
  const ts = nowIso();
  const a: Affiliate = {
    affiliateId: `aff:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId, code,
    name: cleanString(input.name, 200, code),
    commissionType: input.commissionType === 'fixed' ? 'fixed' : 'percentage',
    commissionRate: typeof input.commissionRate === 'number' && input.commissionRate >= 0 ? input.commissionRate : 0,
    balanceOwed: 0, currency: cleanString(input.currency, 8, 'USD').toUpperCase(),
    createdAt: ts, updatedAt: ts,
  };
  await affiliates.put(a);
  recordCommerceAction('affiliate.created', a, 'system', { affiliateId: a.affiliateId, code: a.code, commissionType: a.commissionType, commissionRate: a.commissionRate });
  return a;
}

/**
 * Accrue commission for a paid order that carries an affiliate code: ONE
 * ledger row per order (first-write-wins ⇒ idempotent under redelivery, on
 * top of the caller's pending→paid single fire). Minor-units-first. Returns
 * the accrued amount in MAJOR units (the caller's historical contract).
 */
export async function accrueCommission(order: { tenantId: string; orgId: string; orderId: string; createdAt: string; total: number; currency: string; affiliateCode?: string; createdBy?: string; contactId?: string }): Promise<number> {
  if (!order.affiliateCode) return 0;
  const aff = await findAffiliateRaw(order.tenantId, order.orgId, order.affiliateCode); // grade fix HIGH-1: no projection on the money hot path
  if (!aff) return 0;
  // ADR 0451 P2 — consult accrual-veto guards (e.g. self-referral). Fail-open:
  // a guard error never strands legitimate commission.
  for (const guard of accrualGuards) {
    let allow = true;
    try {
      allow = await guard({ tenantId: order.tenantId, orgId: order.orgId, orderId: order.orderId, createdBy: order.createdBy, contactId: order.contactId, affiliateCode: order.affiliateCode });
    } catch (err) {
      log.warn('affiliate_accrual_guard_failed_fail_open', { orderId: order.orderId, error: err instanceof Error ? err.message : String(err) });
    }
    if (!allow) {
      log.info('affiliate_accrual_vetoed', { orderId: order.orderId, affiliateId: aff.affiliateId });
      return 0;
    }
  }
  // Grade fix LOW-3 (fail-closed): a cross-currency accrual would relabel and
  // mis-scale minor units (a JPY order crediting a USD affiliate). Money is
  // never silently mislabeled — skip with a loud log; the operator can align
  // the affiliate's currency or handle the order manually.
  if (order.currency.toUpperCase() !== aff.currency.toUpperCase()) {
    log.error('accrueCommission: order/affiliate currency mismatch — commission NOT accrued', { affiliateId: aff.affiliateId, orderCurrency: order.currency, affiliateCurrency: aff.currency, orderId: order.orderId });
    return 0;
  }
  const basisMinor = toStripeMinorUnits(order.total, order.currency);
  const commissionMinor = aff.commissionType === 'percentage'
    ? Math.floor((basisMinor * aff.commissionRate) / 100)
    : toStripeMinorUnits(aff.commissionRate, aff.currency);
  if (commissionMinor <= 0) return 0;
  const wrote = await ledger.accrue({
    tenantId: order.tenantId,
    sourceId: order.orderId,
    lineId: aff.code,
    payeeSubject: aff.affiliateId,
    currency: aff.currency,
    basisMinor,
    rateStamp: aff.commissionType === 'percentage' ? aff.commissionRate : -1, // -1 = fixed (stamp is audit-only)
    amountMinor: commissionMinor,
    policyVersion: 0, // affiliates keep per-row frozen rates (ADR 0447 OQ1)
    sourceCreatedAt: order.createdAt,
    meta: { orgId: order.orgId, code: aff.code },
  });
  if (!wrote) return 0; // redelivered — already accrued
  recordCommerceAction('affiliate.commission-accrued', { tenantId: order.tenantId, orgId: order.orgId }, 'system', { affiliateId: aff.affiliateId, commission: fromStripeMinorUnits(commissionMinor, aff.currency), currency: aff.currency });
  return fromStripeMinorUnits(commissionMinor, aff.currency);
}

/** ADR 0447 P2 — the clawback the old lane never had: a fully-refunded order's
 *  commission is mirror-negated (idempotent; best-effort at the call sites). */
export async function reverseCommission(order: { tenantId: string; orderId: string }): Promise<number> {
  return ledger.reverseSource(order.tenantId, order.orderId);
}

/** Record a payout for an affiliate's owed balance (advisory — disbursement is
 *  operator last-mile). Now a payee-scoped ledger run: create claims the
 *  accrued rows (a concurrent call finds nothing left and 409s — fail-closed
 *  by construction), confirm stamps the advisory evidence, and the legacy
 *  Payout row is written as the unchanged compat surface. */
export async function recordPayout(tenantId: string, orgId: string, affiliateId: string): Promise<Payout> {
  const aff = await affiliates.get(affiliateId);
  if (!aff || aff.tenantId !== tenantId || aff.orgId !== orgId) throw new OpenwopError('not_found', 'Affiliate not found.', 404, { affiliateId });
  let amountMinor = 0;
  try {
    const run = await ledger.createRun(tenantId, `payout:${affiliateId}`, { payeeSubject: affiliateId });
    amountMinor = run.entries.reduce((s, e) => s + e.totalMinor, 0);
    await ledger.confirmRun(tenantId, run.runId, `payout:${affiliateId}`, 'advisory:operator-last-mile');
  } catch (err) {
    if (err instanceof ObligationRunError && err.code === 'nothing-accrued') {
      throw new OpenwopError('validation_error', 'No balance owed.', 409, {});
    }
    throw err;
  }
  const payout: Payout = { payoutId: `pay:${randomUUID()}`, tenantId, orgId, affiliateId, amount: fromStripeMinorUnits(amountMinor, aff.currency), currency: aff.currency, status: 'pending', createdAt: nowIso() };
  // Compat surface (listPayouts + pendingPayouts): the ledger run is already
  // the durable truth, so a failure HERE loses only the legacy mirror row —
  // log loud rather than inventing a compensation on money that IS recorded.
  try {
    await payouts.put(payout);
  } catch (err) {
    log.error('recordPayout: ledger run confirmed but legacy payout row failed to persist — export reads stay ledger-true', { affiliateId, amountMinor, error: err instanceof Error ? err.message : String(err) });
  }
  recordCommerceAction('payout.recorded', payout, 'system', { payoutId: payout.payoutId, affiliateId, amount: payout.amount, currency: payout.currency, status: payout.status });
  return payout;
}
export async function listPayouts(tenantId: string, orgId: string): Promise<Payout[]> {
  return (await payouts.listForTenantIndexed(tenantId)).filter((p) => p.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** ADR 0447 D3 — the opening-balance backfill: each affiliate's frozen
 *  `balanceOwed` becomes ONE deterministic ledger row. Idempotent BY KEY
 *  (`sourceId: 'opening-balance'`, first-write-wins), never by sentinel — safe
 *  to run every boot until the field is deleted in P3. */
export async function backfillAffiliateLedger(): Promise<number> {
  let backfilled = 0;
  for (const a of await affiliates.list()) {
    if (a.balanceOwed <= 0) continue;
    const minor = toStripeMinorUnits(a.balanceOwed, a.currency);
    const wrote = await ledger.accrue({
      tenantId: a.tenantId,
      sourceId: 'opening-balance',
      lineId: a.affiliateId,
      payeeSubject: a.affiliateId,
      currency: a.currency,
      basisMinor: minor,
      rateStamp: -1,
      amountMinor: minor,
      policyVersion: 0,
      sourceCreatedAt: a.updatedAt,
      meta: { orgId: a.orgId, code: a.code, openingBalance: 'true' },
    });
    if (wrote) backfilled += 1;
  }
  if (backfilled > 0) log.info('affiliate_ledger_backfilled', { backfilled });
  return backfilled;
}

export async function __resetAffiliates(): Promise<void> {
  await affiliates.__clear();
  await payouts.__clear();
  await ledger.__clear();
}

/** ADR 0297 D2 — the payout export read: every affiliate's owed balance +
 *  pending payouts as rows for a CSV (advisory ledger — disbursement stays
 *  operator last-mile; no money movement here). `balance_owed` is the LEDGER
 *  net (projected reads), so a refund clawback shows here immediately. */
export async function payoutExportRows(tenantId: string, orgId: string): Promise<Array<{ code: string; name: string; currency: string; balanceOwed: number; pendingPayouts: number }>> {
  const all = await listAffiliates(tenantId, orgId); // projected balances
  const pend = (await listPayouts(tenantId, orgId)).filter((p) => p.status === 'pending');
  return all.map((a) => ({
    code: a.code, name: a.name, currency: a.currency,
    balanceOwed: a.balanceOwed,
    pendingPayouts: pend.filter((p) => p.affiliateId === a.affiliateId).reduce((s2, p) => s2 + p.amount, 0),
  }));
}
