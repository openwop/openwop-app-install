/**
 * ADR 0460 (chat-first-port F3 finding 2) — the commerce-connect exception
 * sources.
 *
 * Read-first projections over the stores the feature ALREADY owns (never a second
 * store — the host/exceptionProjection contract).
 *
 * ── disputes ────────────────────────────────────────────────────────────────
 *   - status 'lost' with a realized platform loss (the
 *     `dispute LOST — platform loss realized` line) → action-required;
 *   - status 'open' (a live dispute awaiting the operator's evidence response)
 *     → attention.
 *
 * ── orders (MPL-4 / MPL-5 / WF-MKT-2, added 2026-08-19) ─────────────────────
 *   - an order carrying an `anomaly` stamp — a Stripe purchase whose amount did
 *     not match, or a `charge.refunded` with no usable `amount_refunded`;
 *   - an order whose refund was ISSUED but never CONFIRMED by the webhook within
 *     the SLA below.
 *
 * CORRECTION (MPL-5). This module used to state that the webhook anomalies
 * "are tenant-LESS by nature (there is no order row and no account→tenant index
 * to attribute them to), so they cannot be placed in a tenant-scoped exception
 * ledger without fabricating attribution", and excluded ALL of them on that
 * basis. The rationale is sound for the two branches it named — `purchase event
 * for UNKNOWN order` and `event for unknown Connect account` — which both return
 * BEFORE any order row is resolved, and which are still excluded here.
 *
 * It was FALSE for the amount-MISMATCH branch, and that was the one that mattered:
 * the handler reaches it only because `orders.get(ccOrderId)` SUCCEEDED, so
 * `sellerTenantId` and `buyerTenantId` are both in hand. Attribution was available,
 * not fabricated. So the single anomaly meaning "money was captured and we did not
 * fulfil" was the one anomaly with no operator surface at all — discoverable only
 * by a superadmin eyeballing `/admin/orders`, where a stranded order looks exactly
 * like an ordinary abandoned checkout. The exclusion is now narrowed to the
 * genuinely un-attributable branches, which stay enriched `log.error` lines.
 */

import { disputes, orders, orderSellerIndex, ENTITLED_ORDER_STATUSES, type ConnectOrder } from './stores.js';
import { registerExceptionSource, type ExceptionRow } from '../../host/exceptionProjection.js';

const SOURCE_KEY = 'commerce-connect:disputes';
const ORDER_SOURCE_KEY = 'commerce-connect:order-anomalies';

/**
 * MPL-4 — how long a refund may sit ISSUED-but-unconfirmed before the divergence
 * is an operator exception. `charge.refunded` normally lands in seconds; 30
 * minutes is well past any retry/backoff and well short of "nobody noticed for a
 * day". This is a DETECTION threshold, never a retry: the refund itself is
 * idempotent Stripe-side (`refund:${orderId}`) and is never re-issued from here.
 */
export const REFUND_CONFIRMATION_SLA_MS = 30 * 60 * 1000;

async function disputeExceptionSource(tenantId: string): Promise<ExceptionRow[]> {
  if (!tenantId) return [];
  const rows = await disputes.listForTenantIndexed(tenantId);
  return rows
    .filter((d) => d.status === 'open' || (d.status === 'lost' && d.platformLossMajorUnits > 0))
    .map((d) => {
      const lost = d.status === 'lost';
      return {
        id: `dispute:${d.disputeId}`,
        source: SOURCE_KEY,
        severity: (lost ? 'action-required' : 'attention') as ExceptionRow['severity'],
        label: lost
          ? `Dispute ${d.disputeId} LOST — platform loss ${d.platformLossMajorUnits} ${d.currency.toUpperCase()}${d.orderId ? ` (order ${d.orderId})` : ''}`
          : `Dispute ${d.disputeId} OPEN — evidence response needed${d.orderId ? ` (order ${d.orderId})` : ''}`,
        owner: { kind: 'system' as const, ref: 'system', label: 'operator' },
        action: { labelKey: 'exceptionActionOpen', href: '/commerce-connect' },
        audit: { detectedAt: d.updatedAt, tenantId },
      };
    });
}

/** Both sides of an order are bounded tenant-indexed reads: the BUYER (who was
 *  charged) and the SELLER (who can act). Never a full-collection scan. */
async function ordersForTenant(tenantId: string): Promise<ConnectOrder[]> {
  const purchases = await orders.listForTenantIndexed(tenantId);
  const saleMarkers = await orderSellerIndex.listForTenantIndexed(tenantId);
  const sales = (await Promise.all(saleMarkers.map((m) => orders.get(m.orderId)))).filter((o): o is ConnectOrder => o !== null);
  const seen = new Set(purchases.map((o) => o.orderId));
  return [...purchases, ...sales.filter((o) => !seen.has(o.orderId))];
}

function orderAnomalyRow(o: ConnectOrder, tenantId: string): ExceptionRow | null {
  if (o.anomaly) {
    const captured = o.anomaly.kind === 'purchase-amount-mismatch';
    return {
      id: `order-anomaly:${o.orderId}`,
      source: ORDER_SOURCE_KEY,
      severity: 'action-required',
      label: captured
        // Named for what it MEANS, not for the event that produced it — an
        // operator reading a feed needs the consequence first.
        ? `Order ${o.orderId} — payment captured but NOT fulfilled (amount mismatch): ${o.anomaly.detail}`
        : `Order ${o.orderId} — refund confirmation unusable: ${o.anomaly.detail}`,
      owner: { kind: 'system', ref: 'system', label: 'operator' },
      action: { labelKey: 'exceptionActionOpen', href: '/commerce-connect' },
      audit: { detectedAt: o.anomaly.at, tenantId },
    };
  }
  // MPL-4 — a refund that was issued and never confirmed. An ENTITLED status
  // carrying a `refundRequestedAt` stamp is exactly the divergence that was
  // previously invisible: the money left, the row still says Paid, the buyer
  // still holds the entitlement and the seller's stats still count the sale.
  //
  // SCOPE OF THIS DETECTOR, honestly (review fold-in): it fires on orders whose
  // stamp LANDED. `adminOps.refundOrder` writes that stamp after Stripe has
  // already returned the money, so an order whose stamp never landed — process
  // death between the Stripe 200 and the CAS — is invisible HERE by construction,
  // no matter how reliably this source is polled. `refundOrder` retries a lost
  // CAS and `log.error`s an abandoned stamp for that reason. Closing the residual
  // needs an input that does not depend on our own write (the Stripe refund list,
  // i.e. the reconciliation the deleted sweep did), not a change to this filter.
  // The ENTITLED set again, not two literals — an unconfirmed refund is exactly
  // "money left but the buyer still holds the pack", so this detector's
  // population IS the entitled population and must track it automatically.
  if (o.refundRequestedAt && ENTITLED_ORDER_STATUSES.has(o.status)) {
    const age = Date.now() - Date.parse(o.refundRequestedAt);
    if (Number.isFinite(age) && age > REFUND_CONFIRMATION_SLA_MS) {
      return {
        id: `order-refund-unconfirmed:${o.orderId}`,
        source: ORDER_SOURCE_KEY,
        severity: 'action-required',
        label: `Order ${o.orderId} — refund issued ${o.refundRequestedAt} but Stripe never confirmed it; the order still reads ${o.status}`,
        owner: { kind: 'system', ref: 'system', label: 'operator' },
        action: { labelKey: 'exceptionActionOpen', href: '/commerce-connect' },
        audit: { detectedAt: o.refundRequestedAt, tenantId },
      };
    }
  }
  return null;
}

async function orderExceptionSource(tenantId: string): Promise<ExceptionRow[]> {
  if (!tenantId) return [];
  return (await ordersForTenant(tenantId))
    .map((o) => orderAnomalyRow(o, tenantId))
    .filter((r): r is ExceptionRow => r !== null);
}

export function registerCommerceConnectExceptionSources(): void {
  registerExceptionSource(SOURCE_KEY, disputeExceptionSource);
  registerExceptionSource(ORDER_SOURCE_KEY, orderExceptionSource);
}
