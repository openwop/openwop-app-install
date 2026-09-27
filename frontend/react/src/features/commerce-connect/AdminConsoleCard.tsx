/**
 * Operator console (ADR 0385 Phase 5) — recent orders with a full-refund action
 * (reverse_transfer; the order flips refunded on the webhook) + the dispute /
 * platform-loss ledger. Renders ONLY when the superadmin fetch succeeds — the
 * backend 403 is the authority, the UI just hides (marketplace precedent).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../i18n/format.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { Notice } from '../../ui/Notice.js';
import {
  listAdminOrders, listAdminDisputes, refundAdminOrder, ApiError,
  type ConnectOrder, type ConnectDispute,
} from './commerceConnectClient.js';

/** Order status → StatusBadge tone (the BillingPage PLAN_TONE pattern; passing a
 *  raw domain status would render tone-less since statusTone doesn't know them). */
const ORDER_TONE: Record<string, string> = {
  pending: 'running', paid: 'completed', refunded: 'cancelled',
  // MPL-3 — a partial refund is neither Paid nor Refunded. Rendering it as
  // either misstates money: as Paid it hides that some came back, as Refunded it
  // claims all of it did.
  'partially-refunded': 'waiting-approval',
  disputed: 'waiting-approval', failed: 'failed',
};

export function AdminConsoleCard(): JSX.Element | null {
  const { t } = useTranslation('commerce-connect');
  const [orders, setOrders] = useState<ConnectOrder[] | null>(null);
  const [disputes, setDisputes] = useState<ConnectDispute[]>([]);
  const [loss, setLoss] = useState<Record<string, number>>({});
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void Promise.all([listAdminOrders(), listAdminDisputes()])
      .then(([o, d]) => { setOrders(o); setDisputes(d.disputes); setLoss(d.platformLossMajorUnitsByCurrency); setVisible(true); setFailed(false); })
      .catch((e: unknown) => {
        // UX-CC-1: only "not allowed" hides the card; a transient failure shows
        // a designed error state with a retry (an operator must not lose the
        // console to a network blip that looks like a permissions change).
        const notAllowed = e instanceof ApiError && (e.status === 403 || e.status === 401);
        setVisible(!notAllowed);
        setFailed(!notAllowed);
      });
  }, []);
  useEffect(load, [load]);

  // MKT-UX-19 — busy is keyed by orderId. One flag across every row disabled the
  // whole console on any refund and showed nobody which one was in flight.
  const refund = useCallback(async (o: ConnectOrder) => {
    // MKT-UX-10 — the confirm names the MONEY. It used to name only the pack,
    // while the row that shows the amount sits behind the modal scrim.
    if (!(await confirm({
      title: t('refundConfirm', { amount: formatCurrency(o.amountMajorUnits, o.currency), pack: o.packName }),
      body: t('refundConfirmBody'), danger: true, confirmLabel: t('refund'),
    }))) return;
    setBusy(o.orderId);
    try {
      // MPL-4 — say what actually happened. `applied` is true only when this call
      // itself moved the row (demo lane); on the live lane the flip rides
      // `charge.refunded`, and reporting that as done is the claim the system
      // cannot keep.
      const out = await refundAdminOrder(o.orderId);
      toast.success(out.applied ? t('refundApplied', { pack: o.packName }) : t('refundStarted', { pack: o.packName }));
      load();
    }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(null); }
  }, [load, t]);

  if (!visible) return null;
  if (failed) {
    return (
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <strong>{t('adminTitle')}</strong>
        <Notice variant="error">{t('adminLoadFailed')}</Notice>
        <div className="action-bar"><Button variant="quiet" onClick={load}>{t('retry')}</Button></div>
      </div>
    );
  }
  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <strong>{t('adminTitle')}</strong>
      {Object.keys(loss).length > 0 ? (
        <p className="u-m-0 u-text-sm">
          <span className="muted">{t('platformLoss')}</span>{' '}
          <strong>{Object.entries(loss).map(([cur, v]) => formatCurrency(v, cur)).join(' · ')}</strong>
        </p>
      ) : null}
      {orders === null || orders.length === 0 ? (
        <p className="u-m-0 u-text-sm muted">{t('noOrdersYet')}</p>
      ) : (
        <ul className="u-m-0 u-p-0 u-list-none u-grid u-gap-2">
          {orders.map((o) => (
            <li key={o.orderId} className="action-bar u-justify-between u-items-center u-text-sm">
              <span>
                <code>{o.packName}</code> · {formatCurrency(o.amountMajorUnits, o.currency)}
                {' '}<span className="muted">({t('feeShort', { amount: formatCurrency(o.applicationFeeMajorUnits, o.currency) })})</span>
                {o.status === 'partially-refunded' && o.refundedMajorUnits !== undefined ? (
                  <span className="muted"> · {t('refundedAmount', { amount: formatCurrency(o.refundedMajorUnits, o.currency) })}</span>
                ) : null}
              </span>
              <span className="action-bar u-gap-2 u-items-center">
                <StatusBadge status={ORDER_TONE[o.status] ?? 'paused'} label={t(`order_${o.status}`)} />
                {/* MPL-4 / MKT-UX-10 — a refund that was ISSUED but not yet
                    confirmed by Stripe shows as settling and the action is gone.
                    Previously `load()` re-read an order still `paid` and rendered
                    Refund live again, inviting a second click at a row that had
                    already had its money taken back. */}
                {o.refundRequestedAt && (o.status === 'paid' || o.status === 'partially-refunded') ? (
                  <span className="muted">{t('refundAwaitingStripe')}</span>
                ) : o.status === 'paid' || o.status === 'partially-refunded' ? (
                  // MKT-UX-11 — `variant="danger"`, the convention `ui/ConfirmDialog`
                  // names for irreversible actions. This was `quiet`, visually
                  // identical to Retry sitting beside it.
                  <Button variant="danger" disabled={busy !== null} onClick={() => void refund(o)}>
                    {busy === o.orderId ? t('refunding') : t('refund')}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {disputes.length > 0 ? (
        <>
          <strong className="u-text-sm">{t('disputesTitle')}</strong>
          <ul className="u-m-0 u-p-0 u-list-none u-grid u-gap-2">
            {disputes.map((d) => (
              <li key={d.disputeId} className="action-bar u-justify-between u-items-center u-text-sm">
                <span>{formatCurrency(d.amountMajorUnits, d.currency)}{d.reason ? <span className="muted"> · {d.reason}</span> : null}</span>
                <StatusBadge status={d.status === 'won' ? 'completed' : d.status === 'lost' ? 'failed' : 'waiting-approval'} label={t(`dispute_${d.status}`)} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
