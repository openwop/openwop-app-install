/**
 * UCP purchase detail — /commerce/purchases/:purchaseId?org= (ADR 0336). The
 * landing target for the commerce.ucp-buyer.placed / .status notifications:
 * merchant, status, the human's AP2 intent authorization, the cart the agent
 * assembled, and the payment mandate's approval + honesty warnings. 404s
 * gracefully — getPurchase is tenant-scoped, so a tampered id just fails closed.
 *
 * R2 UCP-P2-B4 — this page was READ-ONLY, which stranded every approved purchase:
 * approving only flips the approval row, and the chat tool (correctly) refuses to
 * finalize, telling the human to complete it HERE. It now carries the governed
 * placement action for an approved purchase, and a reconcile action for `unknown`.
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
import { PurchaseStatusChip } from './PurchasesPage.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { getPurchase, merchantLabel, placeApprovedPurchase, trackPurchase, UcpBuyerApiError, type UcpPurchase } from './ucpBuyerClient.js';

export function PurchaseDetailPage(): JSX.Element {
  const { t } = useTranslation('commerce-ucp-buyer');
  const fmt = useFormat();
  const access = useFeatureAccess('commerce-ucp-buyer');
  const { purchaseId = '' } = useParams();
  const [search] = useSearchParams();
  const orgId = search.get('org') ?? '';

  const [purchase, setPurchase] = useState<UcpPurchase | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (fn: () => Promise<UcpPurchase>, okKey: string) => {
    setBusy(true);
    try { setPurchase(await fn()); toast.info(t(okKey)); }
    catch (e) { toast.error(e instanceof Error && e.message ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  }, [t]);
  const place = useCallback(async () => {
    // The confirm used to assert "This sends the APPROVED order" even from `draft`,
    // where nothing is approved yet (review M-5).
    const approved = purchase?.approvalStatus === 'approved';
    if (!(await confirm({ title: t('placeConfirmTitle'), body: approved ? t('placeConfirmBody') : t('placeConfirmBodyUnapproved'), danger: true, confirmLabel: t('placeCta') }))) return;
    await act(() => placeApprovedPurchase(orgId, purchaseId), 'placeDone');
  }, [act, orgId, purchaseId, purchase, t]);
  const track = useCallback(() => act(() => trackPurchase(orgId, purchaseId), 'trackDone'), [act, orgId, purchaseId]);

  const load = useCallback(() => {
    if (!orgId || !purchaseId) { setState('notfound'); return; }
    setState('loading');
    void getPurchase(orgId, purchaseId)
      .then((p) => { setPurchase(p); setState('ready'); })
      .catch((e) => setState(e instanceof UcpBuyerApiError && e.status === 404 ? 'notfound' : 'error'));
  }, [orgId, purchaseId]);
  // Don't fetch behind a closed gate — the access check is otherwise render-only,
  // so a disabled feature would still fire a (wasted) tenant-scoped request.
  useEffect(() => { if (access.enabled) load(); }, [load, access.enabled]);

  const backLink = <Link className="inline-link u-text-sm" to={`/commerce/purchases${orgId ? `?org=${encodeURIComponent(orgId)}` : ''}`}>← {t('backToPurchases')}</Link>;

  if (access.loading) return <section className="u-grid u-gap-4"><PageHeader eyebrow={t('detailEyebrow')} title={t('detailTitle')} /><Skeleton /></section>;
  if (!access.enabled) return <section className="u-grid u-gap-4"><PageHeader eyebrow={t('detailEyebrow')} title={t('detailTitle')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('detailEyebrow')} title={t('detailTitle')} actions={backLink} />
      {state === 'loading' ? <Skeleton /> : state === 'notfound' ? (
        <StateCard icon={<PackageIcon />} title={t('notFoundTitle')} body={t('notFoundBody')} action={backLink} />
      ) : state === 'error' || !purchase ? (
        <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={load}>{t('retry')}</Button>} />
      ) : (
        <>
          <div className="surface-card u-p-4 u-grid u-gap-2">
            <div className="u-flex u-items-center u-gap-2 u-wrap">
              <strong className="u-fs-15">{merchantLabel(purchase)}</strong>
              <PurchaseStatusChip status={purchase.status} />
              {purchase.extStatus ? <span className="chip chip--muted">{purchase.extStatus}</span> : null}
            </div>
            <div className="u-text-sm muted">
              {t('placedLabel')} {fmt.date(purchase.createdAt)}
              {purchase.extOrderId ? <> · {t('extOrderLabel')} {purchase.extOrderId}</> : null}
            </div>
            {/* R2 UCP-P2-B4 — the completion step. An approved purchase had NO way to
                be placed from any surface, while the agent told the human to finish it
                here. The service re-checks the cap and the sign-off, so this can only
                supply the second call, never skip a gate. */}
            {/* Review M-5 — a primary money CTA that always 409s is worse than none: the
                dominant state here is `awaiting_approval` with a PENDING sign-off, where
                placement cannot succeed. Offer the button only where it can work, and
                point at the sign-off otherwise. `approvalStatus` rides the purchase so
                the page does not have to guess. */}
            {purchase.status === 'awaiting_approval' && purchase.approvalStatus !== 'approved' ? (
              <div className="action-bar u-gap-2">
                <span className="chip chip--warning">{t('awaitingSignOff')}</span>
                <Link className="u-text-sm" to="/reviews">{t('viewApproval')}</Link>
              </div>
            ) : purchase.status === 'draft' || purchase.status === 'failed' || (purchase.status === 'awaiting_approval' && purchase.approvalStatus === 'approved') ? (
              <div className="action-bar u-gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void place()}>{busy ? t('placing') : t('placeCta')}</Button>
                {purchase.approvalId ? <Link className="u-text-sm" to="/reviews">{t('viewApproval')}</Link> : null}
              </div>
            ) : null}
            {purchase.status === 'placed' ? (
              <div className="action-bar u-gap-2">
                <Button variant="secondary" disabled={busy} onClick={() => void track()}>{busy ? t('tracking') : t('trackCta')}</Button>
              </div>
            ) : null}
          </div>

          {/* R2 UCP-P2-M8 — `unknown` is this feature's most dangerous outcome and it
              rendered as a lowercase chip. The service already carries the sentence a
              human needs; it reached no screen. */}
          {purchase.status === 'unknown' ? (
            <Notice variant="warning" announce={t('unknownTitle')}>
              <strong>{t('unknownTitle')}</strong>
              <div className="u-text-sm">{t('unknownBody', { merchant: merchantLabel(purchase) })}</div>
              {purchase.confirmedTotalMinor !== undefined && purchase.confirmedCurrency ? (
                <div className="u-text-sm u-mt-1">
                  {t('divergedAmounts', {
                    authorized: fmt.currencyMinor(purchase.cartMandate.totalMinor, purchase.cartMandate.currency),
                    charged: fmt.currencyMinor(purchase.confirmedTotalMinor, purchase.confirmedCurrency),
                  })}
                </div>
              ) : null}
            </Notice>
          ) : null}

          <div className="surface-card u-p-4 u-grid u-gap-2">
            <strong>{t('authorizationTitle')}</strong>
            <p className="u-m-0">{purchase.intentMandate.intent}</p>
            <div className="u-text-sm muted">{t('ceilingLabel')} {fmt.currencyMinor(purchase.intentMandate.maxAmountMinor, purchase.intentMandate.currency)}</div>
            {/* UCP-G1 — the ceiling and the cart total lived in two separate
                cards and were never related, leaving the reader to do minor-unit
                arithmetic to answer the page's central question: how much of
                what I authorized did the agent spend? The ceiling IS enforced
                server-side (`buildCartMandate` throws `intent_ceiling_exceeded`),
                so this is legibility, not a new guarantee. */}
            <div className="u-text-sm">
              {t('ceilingUsed', {
                spent: fmt.currencyMinor(purchase.cartMandate.totalMinor, purchase.cartMandate.currency),
                ceiling: fmt.currencyMinor(purchase.intentMandate.maxAmountMinor, purchase.intentMandate.currency),
                percent: Math.round((purchase.cartMandate.totalMinor / Math.max(1, purchase.intentMandate.maxAmountMinor)) * 100),
              })}
            </div>
          </div>

          <div className="surface-card u-p-4 u-grid u-gap-3">
            <strong>{t('cartTitle')}</strong>
            <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
              {purchase.cartMandate.lines.map((l, i) => (
                <li key={`${l.externalProductId}-${i}`} className="action-bar u-justify-between u-items-center u-gap-2">
                  <span className="u-flex-1 u-truncate">{l.name} <span className="muted u-text-sm">× {l.quantity}</span></span>
                  <span className="u-text-sm u-tabular">{fmt.currencyMinor(l.unitPriceMinor * l.quantity, purchase.cartMandate.currency)}</span>
                </li>
              ))}
            </ul>
            <div className="action-bar u-justify-between"><strong>{t('totalLabel')}</strong><strong className="u-tabular">{fmt.currencyMinor(purchase.cartMandate.totalMinor, purchase.cartMandate.currency)}</strong></div>
            {/* R2 UCP-P2-B2 — whose number is this? Until now the page showed OUR mandate
                total with no indication that the merchant had never confirmed it. */}
            {purchase.status === 'placed' ? (
              purchase.reconciliation === 'matched' && purchase.confirmedTotalMinor !== undefined && purchase.confirmedCurrency ? (
                <div className="u-text-sm muted">{t('merchantConfirmed', { charged: fmt.currencyMinor(purchase.confirmedTotalMinor, purchase.confirmedCurrency) })}</div>
              ) : (
                <div className="u-text-sm muted">{t('merchantUnconfirmed')}</div>
              )
            ) : null}
          </div>

          {purchase.paymentMandate ? (
            <div className="surface-card u-p-4 u-grid u-gap-2">
              <strong>{t('paymentTitle')}</strong>
              <div className="u-text-sm muted">{t('approvalLabel')} <code>{purchase.paymentMandate.approvalId}</code></div>
              {/* UCP-G2 — warnings arrived as raw `code: prose` strings
                  (`ap2_vc_signing_not_configured: demo-mode mandate — not a
                  verifiable credential`). On a payment-authorization surface, in
                  a four-locale app, the fact that a mandate is NOT a verifiable
                  credential deserves real prose rather than a snake_case dump.
                  An UNKNOWN code still shows its raw string — a warning is never
                  swallowed for failing to match. */}
              {purchase.paymentMandate.warnings.length > 0
                ? purchase.paymentMandate.warnings.map((w, i) => {
                    const code = /^([a-z0-9_]+):\s*(.*)$/i.exec(w);
                    const known = code ? t(`warn_${code[1]}`, { defaultValue: '' }) : '';
                    return (
                      <Notice key={i} variant="warning">
                        {known ? (
                          <span>
                            {known}
                            {code?.[2] ? <span className="u-text-sm muted"> — {code[2]}</span> : null}
                          </span>
                        ) : w}
                      </Notice>
                    );
                  })
                : (
                  /* R2 UCP-P2-I1 — an unqualified green "Signed" asserted more than the
                     code can back: `ap2Mandates` states plainly that a proof shows
                     integrity + self-consistency, NOT authenticity ("an attacker can sign
                     a forged mandate with their OWN key and it will verify"). */
                  <div className="u-text-sm"><span className="chip chip--success">{t('signedIntegrityOnly')}</span></div>
                )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
