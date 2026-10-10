/**
 * Plans × bundles comparison (ADR 0820 §7 UI) — from the SAME reads the store
 * renders (the public plan catalog's feature allowlists × the bundle catalog ×
 * the commerce projection). "Free for now" appears only in the current plan's
 * column: it is this workspace's state, not a property of a plan.
 */
import { useTranslation } from 'react-i18next';
import { compareCell, formatLike, planPrice, planWorth, type Cadence, type CompareCell } from './bundleStoreModel.js';
import type { BundleCommerce, FeatureBundleInfo, PublicPlanTier } from './marketplaceClient.js';

const CELL_CLASS: Record<CompareCell, string> = {
  included: 'chip chip--success',
  free: 'chip chip--accent',
  addon: 'chip chip--muted',
  none: 'muted',
};

export function BundleCompareTable({
  plans, bundles, commerceById, currentTier, cadence,
}: {
  plans: PublicPlanTier[];
  bundles: FeatureBundleInfo[];
  commerceById: Map<string, BundleCommerce>;
  currentTier: string | null;
  cadence: Cadence;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  const label: Record<CompareCell, string> = {
    included: t('storeCellIncluded'), free: t('storeCellFree'), addon: t('storeCellAddon'), none: '—',
  };
  const worths = plans.map((p) => planWorth(p, bundles, commerceById));
  return (
    <div className="table-scroll fstore-compare">
      <table className="data-table data-table--stack-headers">
        <caption className="sr-only">{t('storeCompareCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('storeCompareBundleCol')}</th>
            {plans.map((p) => {
              const pv = planPrice(p, cadence);
              return (
                <th key={p.tier} scope="col">
                  <span className="u-grid">
                    <span>{p.name}{p.tier === currentTier ? <> · <span className="muted">{t('storeCurrentPlan')}</span></> : null}</span>
                    <span className="muted u-text-sm">{pv.price ? `${pv.price}${pv.cadence ?? ''}` : p.tier === 'enterprise' ? t('storeCustomPrice') : '—'}</span>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {bundles.map((b) => {
            const c = commerceById.get(b.id);
            const alone = c?.forSale && c.priceDisplay?.price ? `${c.priceDisplay.price}${c.priceDisplay.cadence ?? ''}` : null;
            return (
              <tr key={b.id}>
                <th scope="row">
                  <span className="u-grid">
                    <span>{b.label}</span>
                    {alone ? <span className="muted u-text-sm">{alone}</span> : null}
                  </span>
                </th>
                {plans.map((p) => {
                  const cell = compareCell(p, b, c, currentTier);
                  return <td key={p.tier}><span className={CELL_CLASS[cell]}>{label[cell]}</span></td>;
                })}
              </tr>
            );
          })}
          {worths.some(Boolean) ? (
            <tr>
              <th scope="row">{t('storeCompareWorthRow')}</th>
              {plans.map((p, i) => {
                const w = worths[i];
                const amount = w ? formatLike(w.template, w.amount) : null;
                return <td key={p.tier}>{amount ? t('storeWorthPerMonth', { amount }) : '—'}</td>;
              })}
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="muted u-text-sm u-mt-2">{t('storeCompareLegend')}</p>
    </div>
  );
}
