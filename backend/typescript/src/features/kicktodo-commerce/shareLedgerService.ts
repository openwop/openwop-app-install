/**
 * Author share ledger (ADR 0445 P1) — the business plan's core commercial
 * promise ("challenge authors receive a percentage of every transaction")
 * as a DERIVED ledger over existing money truth.
 *
 * ADR 0447 P1: this service is now the kicktodo ADAPTER over the extracted
 * `host/obligationLedger` machine — the domain (which order lines accrue, the
 * versioned tenant policy, RBAC at the routes) stays HERE; the state machine
 * (first-write-wins accruals, mirror-negated reversals, CAS-claimed payout
 * runs, evidence-gated flips) lives at the host seam. The public API and every
 * returned shape are byte-compatible: `test/kicktodo-share-ledger.test.ts`
 * passing UNMODIFIED is the extraction's acceptance gate.
 *
 * Money laws (unchanged): derivation rides the ADR 0420 paid/refund observers
 * (downstream of the order-row CAS — the Stripe webhook routing is untouched);
 * observers register unconditionally (accrual/reversal apply with the toggle
 * OFF); minor-units-first with floor discount allocation; tax/shipping
 * excluded; absent policy (or 0 bps) ⇒ NO rows; partial refunds do not claw
 * back (the refund observer fires on FULL refund only — same posture as
 * entitlements); the host never moves money.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import {
  createObligationLedger,
  summarizeObligations,
  ObligationRunError,
  type ObligationRow,
  type ObligationRun,
} from '../../host/obligationLedger.js';
import { createLogger } from '../../observability/logger.js';
import { toStripeMinorUnits } from '../billing/stripeApi.js';
import { listTenantOrdersByStatus, type Order } from '../commerce/commerceService.js';
import { getLinkByProduct } from './entitlementService.js';

const log = createLogger('kicktodo.shares');

/** Tenant-level share policy (versioned like the ADR 0415 rights policy). */
export interface AuthorSharePolicy {
  tenantId: string;
  /** Author share in basis points (0..10000). */
  shareBps: number;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface ShareLedgerRow {
  tenantId: string;
  orderId: string;
  /** The LINE key: money accrues per product line (two products can sell the
   *  SAME challenge in one order; money cannot dedupe per-challenge). */
  productId: string;
  challengeId: string;
  kind: 'accrual' | 'reversal';
  /** The link's `createdBy` at accrual time (opaque subject — ADR 0426 identity). */
  authorSubject: string;
  currency: string;
  /** Line net (after discount allocation), minor units. Negative on reversal. */
  grossMinor: number;
  shareBps: number;
  /** The author's share, minor units. Negative on reversal. */
  shareMinor: number;
  policyVersion: number;
  /** Accrued until a P3 payout run flips it; reversals are terminal. */
  state: 'accrued' | 'paid';
  payoutId?: string;
  orderCreatedAt: string;
  createdAt: string;
}

export interface PayoutRunEntry { authorSubject: string; currency: string; totalMinor: number; rowCount: number }

export interface PayoutRun {
  tenantId: string;
  runId: string;
  state: 'open' | 'confirmed' | 'canceled';
  entries: PayoutRunEntry[];
  createdBy: string;
  createdAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
  /** The external payment evidence (observed Connect payout id / operator note). */
  reference?: string;
}

/** The run-machine error, re-exported under the historical name (routes + tests
 *  match on `instanceof` and `.code` — both preserved). */
export { ObligationRunError as PayoutRunError };

const policies = new DurableCollection<AuthorSharePolicy>(
  'kicktodo-share-policy',
  (p) => p.tenantId,
);

/** ADR 0447 P1 correction (read-tolerance): rows are stored in the machine's
 *  canonical shape. These collections are empty in every deployment (no share
 *  policy has ever been set ⇒ "no policy, no promise" ⇒ zero rows), but a
 *  stray pre-extraction row is upgraded on read rather than dropped. */
function upgradeLegacyRow(parsed: unknown): ObligationRow | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.sourceId === 'string') return parsed as ObligationRow; // canonical
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const orderId = str(p.orderId);
  const productId = str(p.productId);
  const authorSubject = str(p.authorSubject);
  const currency = str(p.currency);
  const orderCreatedAt = str(p.orderCreatedAt);
  const createdAt = str(p.createdAt);
  const tenantId = str(p.tenantId);
  const grossMinor = num(p.grossMinor);
  const shareBps = num(p.shareBps);
  const shareMinor = num(p.shareMinor);
  const policyVersion = num(p.policyVersion);
  const kind = p.kind === 'reversal' ? 'reversal' : p.kind === 'accrual' ? 'accrual' : null;
  const state = p.state === 'paid' ? 'paid' : p.state === 'accrued' ? 'accrued' : null;
  if (!orderId || !productId || !authorSubject || !currency || !orderCreatedAt || !createdAt || !tenantId
    || grossMinor === null || shareBps === null || shareMinor === null || policyVersion === null || !kind || !state) {
    return null; // unreadable garbage — fail closed
  }
  return {
    tenantId,
    sourceId: orderId,
    lineId: productId,
    kind,
    payeeSubject: authorSubject,
    currency,
    basisMinor: grossMinor,
    rateStamp: shareBps,
    amountMinor: shareMinor,
    policyVersion,
    state,
    ...(typeof p.payoutId === 'string' ? { payoutId: p.payoutId } : {}),
    sourceCreatedAt: orderCreatedAt,
    createdAt,
    meta: { challengeId: str(p.challengeId) ?? '' },
  };
}

const ledger = createObligationLedger({
  ns: 'kicktodo-share-ledger',
  runsNs: 'kicktodo-payout-runs',
  logComponent: 'kicktodo.shares.ledger',
  upgradeRow: upgradeLegacyRow,
});

/** Grade fix (2026-07-20 MEDIUM-2) — the read-tolerance hook alone left a trap:
 *  `compareAndSwap` byte-matches the STORED JSON, so a legacy-shaped row read
 *  through `upgradeRow` could never be CAS-claimed into a payout run (silently
 *  excluded forever = stranded money). This boot pass REWRITES legacy rows
 *  canonical UNDER THE SAME KEY (the legacy key string `${t}::${orderId}::
 *  ${productId}[::reversal]` equals the canonical derivation), idempotent by
 *  shape — after it, CAS always matches. Empty collections ⇒ a no-op. */
const legacyShareRowsView = new DurableCollection<ObligationRow>(
  'kicktodo-share-ledger',
  // Canonical key derivation — for a legacy row the STRING is identical
  // (orderId==sourceId, productId==lineId), so put() overwrites in place.
  (r) => `${r.tenantId}::${r.sourceId}::${r.lineId}${r.kind === 'reversal' ? '::reversal' : ''}`,
  (parsed) => {
    const p = parsed as Record<string, unknown> | null;
    if (!p || typeof p.orderId !== 'string' || typeof p.sourceId === 'string') return null; // legacy-shaped only
    return upgradeLegacyRow(parsed);
  },
);

export async function normalizeShareLedgerRows(): Promise<number> {
  let normalized = 0;
  for (const upgraded of await legacyShareRowsView.list()) {
    await legacyShareRowsView.put(upgraded); // same key, canonical bytes
    normalized += 1;
  }
  if (normalized > 0) log.info('kicktodo_share_rows_normalized', { normalized });
  return normalized;
}

const toShareRow = (o: ObligationRow): ShareLedgerRow => ({
  tenantId: o.tenantId,
  orderId: o.sourceId,
  productId: o.lineId,
  challengeId: o.meta?.challengeId ?? '',
  kind: o.kind,
  authorSubject: o.payeeSubject,
  currency: o.currency,
  grossMinor: o.basisMinor,
  shareBps: o.rateStamp,
  shareMinor: o.amountMinor,
  policyVersion: o.policyVersion,
  state: o.state,
  ...(o.payoutId !== undefined ? { payoutId: o.payoutId } : {}),
  orderCreatedAt: o.sourceCreatedAt,
  createdAt: o.createdAt,
});

const toPayoutRun = (r: ObligationRun): PayoutRun => ({
  tenantId: r.tenantId,
  runId: r.runId,
  state: r.state,
  entries: r.entries.map((e) => ({ authorSubject: e.payeeSubject, currency: e.currency, totalMinor: e.totalMinor, rowCount: e.rowCount })),
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  ...(r.confirmedAt !== undefined ? { confirmedAt: r.confirmedAt } : {}),
  ...(r.confirmedBy !== undefined ? { confirmedBy: r.confirmedBy } : {}),
  ...(r.reference !== undefined ? { reference: r.reference } : {}),
});

const nowIso = (): string => new Date().toISOString();

export class SharePolicyError extends Error {}

export async function getSharePolicy(tenantId: string): Promise<AuthorSharePolicy | null> {
  return (await policies.get(tenantId)) ?? null;
}

/** Operator-set (route-gated). Versions monotonically; rows stamp the version
 *  they accrued under, so a change never rewrites existing rows. */
export async function setSharePolicy(tenantId: string, shareBps: number, actor: string): Promise<AuthorSharePolicy> {
  if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10000) {
    throw new SharePolicyError('`shareBps` must be an integer between 0 and 10000.');
  }
  const prior = await policies.get(tenantId);
  const next: AuthorSharePolicy = {
    tenantId,
    shareBps,
    version: (prior?.version ?? 0) + 1,
    updatedAt: nowIso(),
    updatedBy: actor,
  };
  await policies.put(next);
  log.info('kicktodo_share_policy_set', { tenantId, shareBps, version: next.version });
  return next;
}

/** Per-line net in minor units: exact line gross (minor-first, so no float
 *  drift at quantity>1) less a floor-proportional slice of the order discount.
 *  Floor keeps allocation deterministic; the sub-cent remainder stays with the
 *  platform (conservative — never over-credits an author). */
function lineNetMinor(order: Order, line: { unitPrice: number; quantity: number }): number {
  const lineMinor = toStripeMinorUnits(line.unitPrice, order.currency) * line.quantity;
  const subtotalMinor = toStripeMinorUnits(order.subtotal, order.currency);
  const discountMinor = toStripeMinorUnits(order.discount, order.currency);
  if (subtotalMinor <= 0) return 0;
  const lineDiscount = Math.floor((discountMinor * lineMinor) / subtotalMinor);
  return Math.max(0, lineMinor - lineDiscount);
}

/** Derive + apply share effects for one order (idempotent; observer + repair
 *  entry). `mode: 'accrue'` on paid; `'reverse'` on full refund. Returns the
 *  number of rows actually written. */
export async function deriveShares(order: Order, mode: 'accrue' | 'reverse'): Promise<number> {
  let written = 0;
  if (mode === 'accrue') {
    const policy = await getSharePolicy(order.tenantId);
    if (!policy || policy.shareBps <= 0) return 0; // no policy, no promise
    for (const line of order.items ?? []) {
      const link = await getLinkByProduct(order.tenantId, line.productId);
      if (!link) continue;
      const netMinor = lineNetMinor(order, line);
      const shareMinor = Math.floor((netMinor * policy.shareBps) / 10000);
      const wrote = await ledger.accrue({
        tenantId: order.tenantId,
        sourceId: order.orderId,
        lineId: line.productId,
        payeeSubject: link.createdBy,
        currency: order.currency,
        basisMinor: netMinor,
        rateStamp: policy.shareBps,
        amountMinor: shareMinor,
        policyVersion: policy.version,
        sourceCreatedAt: order.createdAt,
        meta: { challengeId: link.challengeId },
      });
      if (wrote) {
        written += 1;
        log.info('kicktodo_share_accrued', { orderId: order.orderId, challengeId: link.challengeId, shareMinor });
      }
    }
  } else {
    written = await ledger.reverseSource(order.tenantId, order.orderId);
  }
  return written;
}

/** KTFULL-B13 discipline for shares: observers are best-effort, so the
 *  operator reconcile entry re-derives share effects for every terminal-state
 *  order. Idempotent — a healthy tenant repairs zero rows. */
export async function reconcileShares(tenantId: string): Promise<{ shareRowsRepaired: number }> {
  let shareRowsRepaired = 0;
  for (const status of ['paid', 'fulfilled'] as const) {
    for (const order of await listTenantOrdersByStatus(tenantId, status)) {
      shareRowsRepaired += await deriveShares(order, 'accrue');
    }
  }
  for (const status of ['refunded', 'canceled'] as const) {
    for (const order of await listTenantOrdersByStatus(tenantId, status)) {
      shareRowsRepaired += await deriveShares(order, 'reverse');
    }
  }
  if (shareRowsRepaired > 0) log.info('kicktodo_shares_reconciled', { tenantId, shareRowsRepaired });
  return { shareRowsRepaired };
}

/** The caller's OWN ledger rows (author view — never another author's). */
export async function listSharesForAuthor(tenantId: string, authorSubject: string): Promise<ShareLedgerRow[]> {
  return (await ledger.listForPayee(tenantId, authorSubject)).map(toShareRow);
}

/** Operator view — the tenant's full ledger (route-gated by manage authority). */
export async function listSharesForTenant(tenantId: string): Promise<ShareLedgerRow[]> {
  return (await ledger.listForTenant(tenantId)).map(toShareRow);
}

/** Accrued/paid totals per currency for one author — the Earnings read.
 *  Reversals subtract from `accruedMinor` (their shareMinor is negative). */
export function summarizeShares(rows: ShareLedgerRow[]): Array<{ currency: string; accruedMinor: number; paidMinor: number }> {
  return summarizeObligations(rows.map((r) => ({ currency: r.currency, state: r.state, amountMinor: r.shareMinor })));
}

// ── Payout runs (ADR 0445 P3 — operator records; the host never moves money) ──

export async function createPayoutRun(tenantId: string, actor: string): Promise<PayoutRun> {
  return toPayoutRun(await ledger.createRun(tenantId, actor));
}

export async function confirmPayoutRun(tenantId: string, runId: string, actor: string, reference: string): Promise<PayoutRun> {
  return toPayoutRun(await ledger.confirmRun(tenantId, runId, actor, reference));
}

export async function cancelPayoutRun(tenantId: string, runId: string): Promise<PayoutRun> {
  return toPayoutRun(await ledger.cancelRun(tenantId, runId));
}

export async function listPayoutRuns(tenantId: string): Promise<PayoutRun[]> {
  return (await ledger.listRuns(tenantId)).map(toPayoutRun);
}
