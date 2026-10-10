/**
 * Bundle detail side panel (ADR 0820 §7 UI) — the full feature list, a computed
 * plan upsell, and a checkout summary. Rides `ui/Modal` (DESIGN.md §5.1: an
 * edge-docked drawer is `Modal` with a docking scrim class, never a second dialog
 * system), so it inherits the focus trap, Escape, focus restore and `aria-modal`.
 * Deep-linkable: the page opens it from `?bundle=<id>`.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { Notice } from '../../ui/Notice.js';
import { CheckIcon, InfoIcon, LockIcon } from '../../ui/icons/index.js';
import { CadenceSwitch } from './CadenceSwitch.js';
import {
  bundlePrice, bundleStatus, canPurchase, cheaperPlanFor, formatLike, requiredBundles,
  type Cadence,
} from './bundleStoreModel.js';
import type { BundleCommerce, FeatureBundleInfo, PublicPlanTier } from './marketplaceClient.js';

export function BundleDetailPanel({
  bundle, commerce, bundles, commerceById, plans, currentTier, cadence, onCadence,
  canBuy, buying, onBuy, onClose, onCompare,
}: {
  bundle: FeatureBundleInfo;
  commerce: BundleCommerce | undefined;
  bundles: FeatureBundleInfo[];
  commerceById: Map<string, BundleCommerce>;
  plans: PublicPlanTier[];
  currentTier: string | null;
  cadence: Cadence;
  onCadence: (c: Cadence) => void;
  canBuy: boolean;
  buying: boolean;
  onBuy: (bundleId: string, cadence: Cadence) => void;
  onClose: () => void;
  onCompare: () => void;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  const status = bundleStatus(commerce);
  const view = bundlePrice(commerce, cadence);
  const month = bundlePrice(commerce, 'month');
  const year = bundlePrice(commerce, 'year');
  const offersBoth = month.sellsChosen && year.sellsChosen;
  const requires = requiredBundles(bundle, bundles);
  const upsell = status === 'available' || status === 'free'
    ? cheaperPlanFor(bundle, plans, bundles, commerceById, currentTier)
    : null;
  const trial = commerce?.trialDays;
  const priced = view.price ? `${view.price}${view.cadence ?? ''}` : null;
  const dueToday = view.price ? (trial ? formatLike(view.price, 0) : view.price) : null;
  // Only where checkout will succeed (server `purchasable`) — never a Buy that 409s.
  const buyable = canPurchase(commerce) && (status === 'available' || status === 'free');
  const titleId = `bundle-detail-${bundle.id}`;

  return (
    <Modal
      onClose={onClose}
      label={bundle.label}
      showClose
      scrimClassName="fstore-drawer-scrim"
      className="fstore-drawer"
    >
      <div className="fstore-drawer__body">
        <header className="u-grid u-gap-1">
          <h2 id={titleId} className="u-m-0">{bundle.label}</h2>
          {commerce?.priceDisplay?.blurb ? <p className="muted u-m-0">{commerce.priceDisplay.blurb}</p> : null}
          {requires.length ? (
            <p className="u-m-0 u-text-sm muted">{t('storeRequires', { bundles: requires.map((b) => b.label).join(', ') })}</p>
          ) : null}
        </header>

        <section className="u-grid u-gap-2" aria-labelledby={`${titleId}-features`}>
          <h3 id={`${titleId}-features`} className="u-m-0 u-fs-16">{t('storeWhatYouGet', { count: bundle.features.length })}</h3>
          <ul className="u-list-plain u-m-0 u-p-0 u-grid u-gap-2">
            {bundle.features.map((f) => (
              <li key={f.id} className="u-flex u-gap-2 u-items-start">
                <span className="fstore-check" aria-hidden><CheckIcon aria-hidden size={16} /></span>
                <span className="u-grid">
                  <span>{f.label ?? f.id}</span>
                  {f.description ? <span className="u-text-sm muted">{f.description}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {upsell ? (
          <Notice variant="info">
            <span className="u-flex u-gap-2 u-items-start">
              <InfoIcon aria-hidden size={16} />
              <span>
                <strong>{t('storeUpsellTitle', { plan: upsell.plan.name })}</strong>{' '}
                {t('storeUpsellBody', {
                  plan: upsell.plan.name,
                  price: `${upsell.plan.display?.price ?? ''}${upsell.plan.display?.cadence ?? ''}`,
                  bundle: bundle.label,
                  others: upsell.others.map((b) => b.label).join(', '),
                })}{' '}
                <Button variant="link" onClick={onCompare}>{t('storeCompareLink')}</Button>
              </span>
            </span>
          </Notice>
        ) : null}

        <section className="surface-card u-p-4 u-grid u-gap-3" aria-labelledby={`${titleId}-summary`}>
          <h3 id={`${titleId}-summary`} className="u-m-0 u-fs-16">{t('storeSummary')}</h3>
          {status === 'owned' ? (
            <>
              <p className="u-m-0"><span className="chip chip--success"><CheckIcon aria-hidden size={14} /> {t('owned')}</span></p>
              {canBuy ? <Link className="btn-ghost btn-sm" to="/billing">{t('manageInPortal')}</Link> : null}
            </>
          ) : status === 'included' ? (
            <p className="u-m-0 muted">{t('includedInPlanHint')}</p>
          ) : status === 'free' && !buyable ? (
            <p className="u-m-0 muted">{t('storeComplimentaryNote')}</p>
          ) : !buyable ? (
            <p className="u-m-0 muted">{t('storeNotForSale')}</p>
          ) : (
            <>
              {status === 'free' ? <p className="u-m-0 u-text-sm muted">{t('storeFreeForNowHint')}</p> : null}
              {offersBoth ? (
                <CadenceSwitch
                  value={cadence}
                  onChange={onCadence}
                  label={t('storeCadenceLabel')}
                  yearHint={year.saving ? t('storeSaveAmount', { amount: year.saving.amount }) : null}
                  monthDetail={month.price ? `${month.price}${month.cadence ?? ''}` : null}
                  yearDetail={year.price ? `${year.price}${year.cadence ?? ''}` : null}
                />
              ) : null}
              <dl className="fstore-summary">
                <dt>{t('storeLineBundle', { bundle: bundle.label })}</dt>
                <dd>{priced ?? '—'}</dd>
                <dt>{t('storeLineSeats')}</dt>
                <dd>{t('storeSeatsUnlimited')}</dd>
                <dt><strong>{t('storeDueToday')}</strong></dt>
                <dd><strong>{dueToday ?? '—'}</strong></dd>
              </dl>
              {trial && priced ? <p className="u-m-0 u-text-sm muted">{t('storeTrialThen', { count: trial, price: priced })}</p> : null}
              {!priced ? <p className="u-m-0 u-text-sm muted">{t('bundlePriceUnavailable')}</p> : null}
              {canBuy ? (
                <Button
                  variant="primary"
                  fullWidth
                  disabled={buying || !view.sellsChosen || !priced}
                  aria-label={priced ? t('storeContinueAria', { bundle: bundle.label, price: priced }) : t('buyAria', { bundle: bundle.label })}
                  onClick={() => onBuy(bundle.id, cadence)}
                >
                  <LockIcon aria-hidden size={14} /> {buying ? t('buying') : priced ? t('storeContinue', { price: priced }) : t('buy')}
                </Button>
              ) : (
                <p className="u-m-0 muted">{t('buyAdminsOnly')}</p>
              )}
              <p className="u-m-0 u-text-sm muted">{t(cadence === 'year' ? 'storeRenewsYearly' : 'storeRenewsMonthly')}</p>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
