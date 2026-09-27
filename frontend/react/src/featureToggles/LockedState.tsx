/**
 * LockedState (ADR 0419) — the "this feature needs an upgrade" panel a locked
 * route renders. Split out of `EntitlementGuard` so it can be LAZY-loaded: the
 * guard wraps EVERY route and therefore sits in the entry chunk, but this panel
 * (and its marketplace-client import) is a rare path and must NOT bloat entry.
 *
 * Without the split, `EntitlementGuard` (entry) and `BundleShopPage` (a lazy
 * chunk) both dynamically import `marketplaceClient`, so Rollup hoists the shared
 * dependency into their common ancestor — the entry chunk — which measurably grew
 * it against a tight bundle budget. Isolating the import behind this lazy boundary
 * keeps it in a `LockedState` chunk.
 */
import { type ReactElement, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../ui/StateCard.js';
import { LockIcon } from '../ui/icons/index.js';
import { fetchFeatureBundles, fetchBundleCommerce } from '../features/marketplace/marketplaceClient.js';
import { telemetry } from '../platform/telemetry.js';

/**
 * Is the bundle that owns `featureId` actually BUYABLE right now? `null` while
 * unknown.
 *
 * This exists because "unlock it in the feature store" is a LIE when the owning
 * bundle carries no configured price: ADR 0419 §Operator note (DATA-419-2) records
 * that a gated feature in an unpriced bundle is a permanent 403 with no store path —
 * the tenant can neither use it nor buy it. Sending them to a store with nothing to
 * sell is the fabricated-affordance failure this repo avoids everywhere (`forSale`
 * derives from a configured price; pricing reads are honest-when-unconfigured).
 *
 * Any failure leaves `purchasable` false ⇒ show the no-store-path copy rather than a
 * CTA we cannot stand behind. Cancels on unmount so a late resolve never sets state
 * on a gone component.
 */
function usePurchasable(featureId: string): boolean | null {
  const [purchasable, setPurchasable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [catalog, commerce] = await Promise.all([fetchFeatureBundles(), fetchBundleCommerce()]);
        const owning = catalog.bundles.find((b) => b.features.some((f) => f.id === featureId));
        if (cancelled) return;
        setPurchasable(owning ? (commerce.find((c) => c.bundleId === owning.id)?.forSale ?? false) : false);
      } catch {
        if (!cancelled) setPurchasable(false); // fail honest: no CTA we cannot honour
      }
    })();
    return () => { cancelled = true; };
  }, [featureId]);
  return purchasable;
}

export function LockedState({ featureId }: { featureId: string }): ReactElement {
  const { t } = useTranslation('chrome');
  const purchasable = usePurchasable(featureId);
  // While the for-sale status is still resolving we render a BUSY card (title only,
  // aria-busy) rather than committing to a body/CTA we might have to swap. Without
  // this the card would flash "unlock it in the store" and then, in the unpriced
  // case, reflow to "ask your administrator" — a jarring text swap. Settling once is
  // calmer AND more honest: we assert nothing about buyability until we know it.
  const resolving = purchasable === null;

  // UI-ENT-1 — paywall-friction telemetry. `app.*` namespace, no-op unless a
  // deployment installs a reporter (VITE_TELEMETRY_ENDPOINT). Reports one impression
  // once the for-sale status is known (so `buyable` is accurate, and an operator can
  // see how many locked views could NOT be resolved to a purchase — the DATA-419-2
  // dead-end). `featureId` is a first-party toggle id, not PII.
  useEffect(() => {
    if (purchasable === null) return; // wait until known so `buyable` is honest
    telemetry.reportEvent('app.entitlement.locked_view', { feature: featureId, buyable: purchasable });
  }, [featureId, purchasable]);

  return (
    <section className="u-grid u-gap-4 u-p-4">
      <StateCard
        icon={<LockIcon />}
        title={t('lockedFeatureTitle')}
        loading={resolving}
        body={resolving ? undefined : (purchasable ? t('lockedFeatureBody') : t('lockedFeatureNoStoreBody'))}
        action={purchasable === true
          ? (
            <Link
              className="btn-accent btn-sm"
              to="/marketplace/bundles"
              onClick={() => telemetry.reportEvent('app.entitlement.upsell_click', { feature: featureId })}
            >{t('lockedFeatureCta')}</Link>
          )
          : undefined}
      />
    </section>
  );
}
