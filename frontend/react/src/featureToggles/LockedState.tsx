/**
 * LockedState (ADR 0419) — the panel a locked route renders. Split out of
 * `EntitlementGuard` so it can be LAZY-loaded: the guard wraps EVERY route and
 * therefore sits in the entry chunk, but this panel is a rare path and must NOT
 * bloat entry.
 *
 * Its own static imports are kept to what the entry already holds (React, i18n,
 * `StateCard`, the icon set, telemetry). Everything else — the marketplace client,
 * the store model, billing's scope, the prompt — is ONE further dynamic import
 * (`features/marketplace/LockedUpgradePrompt`). Vite lists a lazy chunk's static
 * dependencies in the ENTRY chunk's preload map, so every static import here costs
 * entry bytes; a second hop does not. (History: when `EntitlementGuard` itself
 * imported `marketplaceClient`, Rollup hoisted it into entry.)
 *
 * This is also THE deep-link locked mapping: a bookmarked page whose read gets the
 * plan 403 re-resolves entitlements (`client/entitlementRefresh`), and the guard
 * then renders this panel — so the specific upgrade prompt lands here once, not per
 * page.
 *
 * ADR 0419 §8 follow-on / ADR 0820 §7 — the panel names the bundle that sells the
 * feature, its price and the way to add it, resolved from catalog + store DATA. A
 * feature no bundle sells keeps the generic copy below.
 */
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../ui/StateCard.js';
import { LockIcon } from '../ui/icons/index.js';
import { telemetry } from '../platform/telemetry.js';

type PromptModule = typeof import('../features/marketplace/LockedUpgradePrompt.js');
type Upsell = ReturnType<PromptModule['resolveUpsell']>;
const loadPrompt = (): Promise<PromptModule> => import('../features/marketplace/LockedUpgradePrompt.js');
/** Strategy §8 — the paywall funnel beacon, one dynamic hop away (no entry bytes). */
const notePaywall = (metric: 'impression' | 'click', featureId: string): void => {
  void import('./paywallBeacon.js').then((m) => { m.notePaywall(metric, featureId, 'locked-page'); }, () => undefined);
};

/** The nav's lock targets (`featureToggles/lockedTargets`), one hop further. */
export const lockedTargets = (): ReturnType<typeof import('../features/marketplace/lockedUpsell.js')['lockedTargets']> =>
  import('../features/marketplace/lockedUpsell.js').then((m) => m.lockedTargets());

/**
 * The resolved prompt for `featureId`: `undefined` while unknown, `null` when no
 * bundle sells it (or the catalog could not be read), else the upsell and the
 * module that renders it.
 *
 * "Unlock it in the feature store" is a LIE when the owning bundle carries no
 * configured price: ADR 0419 §Operator note (DATA-419-2) records that a gated
 * feature in an unpriced bundle is a permanent 403 with no store path. So the CTA
 * renders only when the store says a checkout would be accepted (`purchasable`);
 * a failed store read reads as not purchasable — never a CTA we cannot stand behind.
 * Cancels on unmount so a late resolve never sets state on a gone component.
 */
function useUpsell(featureId: string): { m: PromptModule; upsell: NonNullable<Upsell> } | null | undefined {
  const [state, setState] = useState<{ m: PromptModule; upsell: NonNullable<Upsell> } | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadPrompt()
      .then(async (m) => {
        const upsell = m.resolveUpsell(featureId, await m.loadUpsellData());
        if (!cancelled) setState(upsell ? { m, upsell } : null);
      })
      .catch(() => { if (!cancelled) setState(null); }); // fail honest: no CTA we cannot honour
    return () => { cancelled = true; };
  }, [featureId]);
  return state;
}

export function LockedState({ featureId }: { featureId: string }): ReactElement {
  const { t } = useTranslation('chrome');
  const state = useUpsell(featureId);
  // While the for-sale status is still resolving we render a BUSY card (title only,
  // aria-busy) rather than committing to a body/CTA we might have to swap.
  const resolving = state === undefined;
  const bundle = state?.upsell.bundle.id;
  const buyable = state?.upsell.purchasable === true;

  // UI-ENT-1 — paywall-friction telemetry on the existing `app.*` seam (no-op unless
  // a deployment installs a reporter). One impression once buyability is known, now
  // with the bundle that would unlock it. Ids are first-party toggle/bundle ids.
  useEffect(() => {
    if (resolving) return;
    telemetry.reportEvent('app.entitlement.locked_view', { feature: featureId, buyable, ...(bundle ? { bundle } : {}) });
    notePaywall('impression', featureId);
  }, [featureId, resolving, buyable, bundle]);

  if (state) {
    const { m, upsell } = state;
    return (
      <section className="u-grid u-gap-4 u-p-4">
        <m.LockedUpgradePrompt
          upsell={upsell}
          onUpsellClick={(target) => { telemetry.reportEvent('app.entitlement.upsell_click', { feature: featureId, bundle: upsell.bundle.id, target }); notePaywall('click', featureId); }}
        />
        {/* ADR 0820 §7 — "Export your data" rides the prompt module this panel
            already loads (zero entry bytes); it renders only for an admin/owner. */}
        <m.ExportDataButton featureId={featureId} />
      </section>
    );
  }
  return (
    <section className="u-grid u-gap-4 u-p-4">
      <StateCard
        icon={<LockIcon />}
        title={t('lockedFeatureTitle')}
        loading={resolving}
        body={resolving ? undefined : t('lockedFeatureNoStoreBody')}
      />
    </section>
  );
}
