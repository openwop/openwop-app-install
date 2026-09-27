/**
 * Order detail — `/commerce/orders/:orderId?org=<orgId>` (deep-link program
 * Phase 2). The landing target for the `commerce.order.paid` notification: an
 * "order confirmed / shipped" ping now opens THIS page (line items, fulfilment
 * ladder, refund legs, the money actions) instead of dumping the operator on
 * the Products tab. Mirrors the CRM DealDetailPage route shape. Reads the store
 * from `?org=` and 404s gracefully (no existence leak — the backend scopes
 * getOrder to the caller's tenant).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { PackageIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useFormat } from '../../i18n/useFormat.js';
import { StatusChip, OrderActions, orderChargeTotal } from './commerceShared.js';
import { getOrder, listOrderRefunds, CommerceApiError, type Order, type OrderRefund } from './commerceClient.js';

export function OrderDetailPage(): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const access = useFeatureAccess('commerce');
  const { orderId = '' } = useParams();
  const [search] = useSearchParams();
  const orgId = search.get('org') ?? '';

  const [order, setOrder] = useState<Order | null>(null);
  const [refunds, setRefunds] = useState<OrderRefund[]>([]);
  // COM-G3 — a failed refunds read used to `setRefunds([])`, i.e. render exactly
  // like "no refunds". On a money page that can directly contradict the
  // `refundedAmount` shown above it: "Refunded −$50" over an absent list.
  const [refundsFailed, setRefundsFailed] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');

  const load = useCallback(() => {
    if (!orgId || !orderId) { setState('notfound'); return; }
    setState('loading');
    void getOrder(orgId, orderId)
      .then((o) => {
        setOrder(o);
        setState('ready');
        setRefundsFailed(false);
        void listOrderRefunds(orgId, orderId)
          .then((r) => { setRefunds(r); setRefundsFailed(false); })
          .catch(() => { setRefunds([]); setRefundsFailed(true); });
      })
      .catch((e) => setState(e instanceof CommerceApiError && e.status === 404 ? 'notfound' : 'error'));
  }, [orgId, orderId]);

  // Don't fetch behind a closed gate — the access check is otherwise render-only,
  // so a disabled feature would still fire a (wasted) tenant-scoped request.
  useEffect(() => { if (access.enabled) load(); }, [load, access.enabled]);

  const backLink = (
    <Link className="inline-link u-text-sm" to={`/commerce?tab=orders${orgId ? `&org=${encodeURIComponent(orgId)}` : ''}`}>
      ← {t('backToOrders')}
    </Link>
  );

  // COM-G1 — the amount actually billed, and whether it differs from the goods
  // total (i.e. whether the summary needs to show both lines).
  const charged = order ? orderChargeTotal(order) : 0;
  const hasExtras = order ? charged !== order.total : false;

  if (access.loading) return <section className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('orderDetailTitle')} /><Skeleton /></section>;
  if (!access.enabled) return <section className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('orderDetailTitle')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('orderDetailEyebrow')} title={t('orderDetailTitle')} actions={backLink} />
      {state === 'loading' ? <Skeleton /> : state === 'notfound' ? (
        <StateCard icon={<PackageIcon />} title={t('orderNotFoundTitle')} body={t('orderNotFoundBody')} action={backLink} />
      ) : state === 'error' || !order ? (
        <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={load}>{t('retry')}</Button>} />
      ) : (
        <>
          <div className="surface-card u-p-4 u-grid u-gap-3">
            <div className="action-bar u-justify-between u-items-start u-gap-2">
              <div className="u-grid u-gap-1">
                <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
                  <code className="u-text-sm">{order.orderId}</code>
                  <StatusChip value={order.status} />
                  {(order.status === 'paid' || order.status === 'fulfilled') ? <StatusChip value={order.fulfillmentStatus} /> : null}
                </div>
                <div className="u-text-sm muted">{t('placedLabel')} {fmt.date(order.createdAt)}{order.couponCode ? <> · {order.couponCode}</> : null}</div>
              </div>
              <OrderActions orgId={orgId} order={order} onChanged={load} />
            </div>
            {order.status === 'pending' ? <Notice variant="info">{t('approvalHint')}</Notice> : null}
          </div>

          <div className="surface-card u-p-4 u-grid u-gap-3">
            <strong>{t('lineItemsTitle')}</strong>
            <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
              {order.items.map((it, i) => (
                <li key={`${it.productId}-${i}`} className="action-bar u-justify-between u-items-center u-gap-2">
                  <span className="u-flex-1 u-truncate">{it.name} <span className="muted u-text-sm">× {it.quantity}</span></span>
                  <span className="u-text-sm u-tabular">{fmt.currency(it.unitPrice * it.quantity, order.currency)}</span>
                </li>
              ))}
            </ul>
            <dl className="u-grid u-gap-1 u-m-0 u-text-sm">
              <div className="action-bar u-justify-between"><dt className="muted">{t('subtotalLabel')}</dt><dd className="u-m-0 u-tabular">{fmt.currency(order.subtotal, order.currency)}</dd></div>
              {order.discount > 0 ? <div className="action-bar u-justify-between"><dt className="muted">{t('discountLabel')}</dt><dd className="u-m-0 u-tabular">−{fmt.currency(order.discount, order.currency)}</dd></div> : null}
              {(order.taxTotal ?? 0) > 0 ? <div className="action-bar u-justify-between"><dt className="muted">{t('taxLabel')}</dt><dd className="u-m-0 u-tabular">{fmt.currency(order.taxTotal!, order.currency)}</dd></div> : null}
              {(order.shippingCost ?? 0) > 0 ? <div className="action-bar u-justify-between"><dt className="muted">{t('shippingLabel')}</dt><dd className="u-m-0 u-tabular">{fmt.currency(order.shippingCost!, order.currency)}</dd></div> : null}
              {/* COM-G1 — `Order.total` is goods-after-discount; the amount actually
                  billed is `total + tax + shipping` (the type's own docblock says
                  the Stripe charge bills `orderChargeTotal`). Rendering `total` in
                  bold BELOW the tax and shipping lines put a number nobody paid in
                  the one position every invoice reserves for the grand total. When
                  there is no tax or shipping the two are equal, so the summary
                  stays a single line rather than growing a redundant row. */}
              {hasExtras ? (
                <>
                  <div className="action-bar u-justify-between"><dt className="muted">{t('goodsTotalLabel')}</dt><dd className="u-m-0 u-tabular">{fmt.currency(order.total, order.currency)}</dd></div>
                  <div className="action-bar u-justify-between"><dt><strong>{t('chargedLabel')}</strong></dt><dd className="u-m-0 u-tabular"><strong>{fmt.currency(charged, order.currency)}</strong></dd></div>
                </>
              ) : (
                <div className="action-bar u-justify-between"><dt><strong>{t('totalLabel')}</strong></dt><dd className="u-m-0 u-tabular"><strong>{fmt.currency(order.total, order.currency)}</strong></dd></div>
              )}
              {(order.refundedAmount ?? 0) > 0 ? <div className="action-bar u-justify-between"><dt className="muted">{t('refundedLabel')}</dt><dd className="u-m-0 u-tabular">−{fmt.currency(order.refundedAmount!, order.currency)}</dd></div> : null}
              {/* R2 CM-P2-B3 — a workflow/agent refund used to flip the order to
                  `refunded` without touching the card, and no screen could tell that
                  apart from a real one. Only 'none' is stated: absent means a pre-R2 row
                  whose lane we genuinely do not know, and claiming either way would lie. */}
              {(order.refundedAmount ?? 0) > 0 && order.refundProvider === 'none' ? (
                <div className="action-bar u-justify-between"><dt className="muted">{t('refundLaneLabel')}</dt><dd className="u-m-0"><span className="chip chip--warning">{t('refundStateOnly')}</span></dd></div>
              ) : null}
            </dl>
          </div>

          {refundsFailed ? (
            <Notice variant="warning" announce={t('refundsLoadFailed')}>
              {t('refundsLoadFailed')}{' '}
              <Button variant="link" onClick={load}>{t('retry')}</Button>
            </Notice>
          ) : null}

          {refunds.length > 0 ? (
            <div className="surface-card u-p-4 u-grid u-gap-2">
              <strong>{t('refundsTitle')}</strong>
              <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
                {refunds.map((r) => (
                  <li key={r.refundLedgerId} className="action-bar u-justify-between u-items-center u-gap-2 u-text-sm">
                    {/* ADR 0615 — a row is only "a refund that happened" once it is
                        `applied`. A `pending` row is a claim whose owner may have died
                        AFTER the provider took the money, so the `provider === 'none'`
                        chip ("no money returned") would be an outright lie on it; and a
                        `manual_intervention_required` row carries a real refundId and
                        would otherwise render as a clean, completed refund. Both are
                        disclosed instead. */}
                    <span className="muted">{fmt.date(r.createdAt)}{r.refundId ? <> · {r.refundId}</> : null}
                      {r.state === 'manual_intervention_required' ? <> · <span className="chip chip--danger">{t('refundNeedsAttention')}</span></>
                        : r.state === 'pending' ? <> · <span className="chip chip--warning">{t('refundUnconfirmed')}</span></>
                        : r.provider === 'none' ? <> · <span className="chip chip--warning">{t('refundStateOnly')}</span></> : null}</span>
                    <span className="u-tabular">−{fmt.currency(r.amount, r.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
