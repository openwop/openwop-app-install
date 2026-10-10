/**
 * The locked-feature upgrade prompt (ADR 0419 §8 follow-on, ADR 0820 §7) — what a
 * locked page renders once `lockedUpsell.resolveUpsell` has named the bundle that
 * sells the feature. Rendered by `featureToggles/LockedState` (lazy), so it never
 * reaches the entry chunk, and its copy lives in the lazy `marketplace` namespace.
 *
 * Three honest arms, one `StateCard`:
 *  - buyable + the viewer may buy (`host:billing:manage`): name, value line, the
 *    monthly price with the yearly one underneath, a primary "Add {bundle} · $X/mo"
 *    that OPENS the store's detail panel (`?bundle=<id>`, never checkout), and a
 *    plan line when a plan is computably the better buy;
 *  - buyable, but the viewer may not buy: the same facts, "Ask a workspace admin
 *    to add {bundle}", and no buy CTA;
 *  - not purchasable (unpriced / misconfigured / store unreadable): honest copy,
 *    no price, no CTA.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { LockIcon } from '../../ui/icons/index.js';
import { useScopeWriteAccess } from '../../lib/writeAccess.js';
import { BILLING_MANAGE_SCOPE } from '../billing/billingClient.js';
import { bundleHref, COMPARE_HREF, type LockedUpsell } from './lockedUpsell.js';

// `LockedState` reaches this module (and the data half) through ONE dynamic
// import, so none of these dependencies are listed in the entry chunk's preload map.
export { loadUpsellData, resolveUpsell } from './lockedUpsell.js';
// ADR 0820 §7 — the lock page's "Export your data" button, through the same hop.
export { ExportDataButton } from '../billing/ExportDataButton.js';

export function LockedUpgradePrompt({ upsell, onUpsellClick }: {
  upsell: LockedUpsell;
  /** Telemetry hook for the primary CTA (the caller owns the event seam). */
  onUpsellClick?: (target: 'bundle' | 'compare') => void;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  // ADR 0786 D5 — only a billing manager may buy; the server refuses anyone else.
  const canBuy = useScopeWriteAccess(BILLING_MANAGE_SCOPE);
  const name = upsell.bundle.label;
  if (!upsell.purchasable) {
    return (
      <StateCard
        icon={<LockIcon />}
        title={t('lockedPromptTitle', { bundle: name })}
        body={t('lockedPromptNotForSale', { bundle: name })}
      />
    );
  }
  const body = (
    <span className="u-grid u-gap-1">
      {upsell.blurb ? <span>{upsell.blurb}</span> : null}
      {upsell.monthly || upsell.yearly ? (
        <span>
          <strong>{upsell.monthly ?? upsell.yearly}</strong>
          {upsell.monthly && upsell.yearly ? <span className="muted"> · {t('storeOr', { price: upsell.yearly })}</span> : null}
        </span>
      ) : null}
      {canBuy && upsell.plan ? (
        <span className="u-text-sm muted">
          {t('lockedPromptPlan', { plan: upsell.plan.name, price: upsell.plan.price, n: upsell.plan.bundles })}{' '}
          <Link to={COMPARE_HREF} onClick={() => onUpsellClick?.('compare')}>{t('lockedPromptCompare')}</Link>
        </span>
      ) : null}
      {canBuy ? null : <span>{t('lockedPromptAskAdmin', { bundle: name })}</span>}
    </span>
  );
  const price = upsell.monthly ?? upsell.yearly;
  return (
    <StateCard
      icon={<LockIcon />}
      title={t('lockedPromptTitle', { bundle: name })}
      body={body}
      action={canBuy ? (
        <Link className="btn-accent btn-sm" to={bundleHref(upsell.bundle.id)} onClick={() => onUpsellClick?.('bundle')}>
          {price ? t('lockedPromptCta', { bundle: name, price }) : t('lockedPromptCtaNoPrice', { bundle: name })}
        </Link>
      ) : undefined}
    />
  );
}
