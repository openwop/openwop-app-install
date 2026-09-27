/**
 * Shared commerce UI primitives used by BOTH the tabbed back-office
 * (`CommercePage`) and the deep-linkable `OrderDetailPage` (deep-link program
 * Phase 2). Extracted so the order-action logic (pay / advance / refund /
 * cancel, incl. the refund confirm + error mapping) has ONE owner and can't
 * drift between the list row and the detail page.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import {
  payOrder, refundOrder, partialRefundOrder, cancelOrder, advanceFulfillment,
  CommerceApiError, type Order,
} from './commerceClient.js';

/** grade-code M1: branch on the canonical error CODE, not a substring of the
 *  (localizable) message — pending vs rejected give different guidance. */
export function actionError(e: unknown, t: (k: string) => string): void {
  if (e instanceof CommerceApiError && e.code === 'approval_required') {
    const status = (e.details as { approvalStatus?: string } | undefined)?.approvalStatus;
    toast.info(t(status === 'rejected' ? 'approvalRejected' : 'approvalParked'));
    return;
  }
  toast.error((e instanceof Error && e.message) || t('actionFailed'));
}

// ── status → chip semantics (DESIGN.md §5.3 — label, never color alone) ──
// Terminal-good → success, reversed/expired → warning, in-flight money/fulfilment
// → ai (accent), plain-neutral → no tone.
const STATUS_TONE: Record<string, string> = {
  paid: 'chip--success', fulfilled: 'chip--success', accepted: 'chip--success', converted: 'chip--success', delivered: 'chip--success',
  refunded: 'chip--warning', declined: 'chip--warning', expired: 'chip--warning', canceled: 'chip--warning', partially_refunded: 'chip--warning',
  refunding: 'chip--ai', processing: 'chip--ai', shipped: 'chip--ai',
  // pending / draft / sent are deliberately neutral (no tone) — not a fall-through.
};

export function StatusChip({ value }: { value: string }): JSX.Element {
  const { t } = useTranslation('commerce');
  const tone = STATUS_TONE[value] ?? '';
  return <span className={`chip ${tone}`.trim()}>{t(`status_${value}`, { defaultValue: value })}</span>;
}

/**
 * COM-G1 — what the customer was ACTUALLY charged. Mirrors the backend's
 * `orderChargeTotal`: `Order.total` is goods-after-discount, and its docblock is
 * explicit that "the Stripe charge and the paid-amount verification bill
 * orderChargeTotal = total + taxTotal + shippingCost". Anything presenting
 * `total` as the bottom line of a summary that also lists tax and shipping is
 * naming a number nobody paid.
 */
export function orderChargeTotal(o: Pick<Order, 'total' | 'taxTotal' | 'shippingCost'>): number {
  return Math.round((o.total + (o.taxTotal ?? 0) + (o.shippingCost ?? 0)) * 100) / 100;
}

/** How much of the charge is still refundable — the same arithmetic the backend
 *  uses to REJECT an over-refund. Showing it stops the operator typing blind. */
export function refundableRemaining(o: Pick<Order, 'total' | 'taxTotal' | 'shippingCost' | 'refundedAmount'>): number {
  return Math.round((orderChargeTotal(o) - (o.refundedAmount ?? 0)) * 100) / 100;
}

/** The next rung on the fulfilment ladder, or null when delivered/not-yet-paid. */
export function nextFulfillment(o: Order): string | null {
  return o.fulfillmentStatus === 'pending' ? 'processing'
    : o.fulfillmentStatus === 'processing' ? 'shipped'
    : o.fulfillmentStatus === 'shipped' ? 'delivered'
    : null;
}

/** DEF-7 — an inline amount entry for a partial refund. A fresh `refundKey` per submit
 *  makes the request idempotent (a double-click won't double-refund). */
function PartialRefundControl({ orgId, order, onDone }: { orgId: string; order: Order; onDone: (fn: () => Promise<unknown>) => void }): JSX.Element {
  const { t } = useTranslation('commerce');
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  const amt = Number(amount);
  const remaining = refundableRemaining(order);
  // COM-G2 — the backend REJECTS an over-refund (`amt > remaining`), so money was
  // never at risk. The operator just had no way to know the ceiling and typed
  // blind into a rejection. Bound the control by the same arithmetic.
  const valid = Number.isFinite(amt) && amt > 0 && amt <= remaining;
  const submit = (): void => {
    if (!valid) return;
    // COM-G2 — the FULL refund beside this one confirms; this one fired straight
    // from a click or a stray Enter. A partial refund moves real money and cannot
    // be undone, so it gets the same guard, naming the amount.
    void (async () => {
      const ok = await confirm({
        title: t('partialRefundConfirmTitle', { amount: `${amt} ${order.currency}` }),
        body: t('partialRefundConfirmBody'),
        danger: true,
        confirmLabel: t('refund'),
      });
      if (!ok) return;
      const refundKey = (globalThis.crypto?.randomUUID?.() ?? `rk-${Date.now()}`);
      onDone(() => partialRefundOrder(orgId, order.orderId, amt, refundKey));
      setOpen(false); setAmount('');
    })();
  };
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>{t('partialRefund')}</Button>;
  return (
    <span className="action-bar u-gap-1 u-items-center">
      <input ref={inputRef} type="number" min="0" max={remaining} step="0.01" inputMode="decimal" className="u-w-auto" aria-label={t('partialRefundAmount')} placeholder="0.00" value={amount}
        onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setOpen(false); setAmount(''); } }} />
      <span className="u-text-sm muted">{t('refundRemaining', { amount: `${remaining} ${order.currency}` })}</span>
      <Button variant="secondary" onClick={submit} disabled={!valid}>{t('apply')}</Button>
      <Button variant="secondary" onClick={() => { setOpen(false); setAmount(''); }}>{t('cancel')}</Button>
    </span>
  );
}

/**
 * The order action cluster (pay / cancel / advance-fulfilment / refund /
 * partial-refund), gated by the order's status. ONE owner for the money-adjacent
 * buttons — the list row and the detail page both render this, so a change to
 * an action or its confirm lands in both places. `onChanged` refetches.
 */
export function OrderActions({ orgId, order, onChanged }: { orgId: string; order: Order; onChanged: () => void }): JSX.Element {
  const { t } = useTranslation('commerce');
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try { await fn(); onChanged(); } catch (e) { actionError(e, t); }
  }, [onChanged, t]);
  const next = nextFulfillment(order);
  const settled = order.status === 'paid' || order.status === 'fulfilled';
  // R2 CM-P2-B1 — `refunding` used to render ZERO actions, so a Stripe failure mid-refund
  // left the order frozen with no way to finish it and no statement of where the money
  // was. The refund is now resumable, so offer it (labelled as a retry) and say why.
  const wedged = order.status === 'refunding';
  return (
    <div className="action-bar u-gap-1">
      {wedged ? (
        <>
          <span className="chip chip--warning">{t('refundInterrupted')}</span>
          <Button variant="secondary" onClick={() => void (async () => { if (await confirm({ title: t('refundRetryConfirmTitle'), body: t('refundRetryConfirmBody'), danger: true, confirmLabel: t('refundRetry') })) act(() => refundOrder(orgId, order.orderId)); })()}>{t('refundRetry')}</Button>
        </>
      ) : null}
      {order.status === 'pending' ? (
        <>
          <Button variant="secondary" onClick={() => void act(() => payOrder(orgId, order.orderId, `manual:${Date.now()}`))}>{t('markPaid')}</Button>
          <Button variant="secondary" onClick={() => void act(() => cancelOrder(orgId, order.orderId))}>{t('cancelOrder')}</Button>
        </>
      ) : null}
      {settled && next ? (
        <Button variant="secondary" onClick={() => void act(() => advanceFulfillment(orgId, order.orderId, next))}>{t(`advance_${next}`)}</Button>
      ) : null}
      {settled ? (
        <Button variant="secondary" onClick={() => void (async () => { if (await confirm({ title: t('refundConfirmTitle'), body: t('refundConfirmBody'), danger: true, confirmLabel: t('refund') })) act(() => refundOrder(orgId, order.orderId)); })()}>{t('refund')}</Button>
      ) : null}
      {settled || order.status === 'partially_refunded' ? (
        <PartialRefundControl orgId={orgId} order={order} onDone={(fn) => void act(fn)} />
      ) : null}
    </div>
  );
}
