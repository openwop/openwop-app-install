/**
 * Marketplace console — one destination over the feature store
 * (`/marketplace/bundles`), the signed-pack registry (`/marketplace`) and the
 * white-label composer (`/marketplace/distribution`).
 *
 * It is the same hub primitive as Models / Campaign Studio / Chat deployment /
 * Access (ADR 0144/0145): the tabs PROJECT from the `FEATURES` manifest through
 * `visibleHubRoutes(FEATURES, isVisible, isAdmin, 'marketplace')` (each route's
 * `hubTab` annotation IS the registration, gated by the same toggle + tier
 * predicate the rail uses), rendered with the shared `<Tabs>`/`<TabPanel>`, the
 * pane wrapped in `HubProvider` so it drops its own `<PageHeader>`, and the panel
 * guarded by its own Suspense + ErrorBoundary (ADR 0715).
 *
 * ONE deliberate difference: the tabs are PATH-routed, not `?tab=`. The other
 * consoles front surfaces that live at unrelated URLs, so a query param is the
 * only shared address. These three already share the `/marketplace` prefix and
 * are deep-linked as paths from everywhere — nav lock links and locked-feature
 * prompts (`/marketplace/bundles?feature=` / `?bundle=`), the Stripe return URLs
 * (`/marketplace/bundles?checkout=`, `/marketplace?purchase=`), bookmarks. So the
 * active tab is the route that matched, a tab click is a navigation, and every
 * existing URL keeps meaning what it meant. Consequently all three routes'
 * `element` is this hub (see `routes.tsx`) and the hub renders the matched route's
 * PAGE from `PAGES` below rather than `route.element`, which would nest the hub in
 * itself. Holding the three page imports HERE, in the hub's lazy chunk, is also
 * what keeps the manifest (entry chunk) at one lazy import instead of four.
 *
 * Reading `FEATURES` here is safe: this module is lazy-imported by `routes.tsx`,
 * so by render time the manifest is fully composed (the ModelsHubPage precedent).
 */
import { lazy, Suspense, useMemo, type ComponentType } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from '../../ui/index.js';
import { FEATURES } from '../../chrome/features.js';
import { HubProvider } from '../../chrome/hubContext.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { useEffectiveAccess, isAdminCaller } from '../../client/useEffectiveAccess.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Tabs, TabPanel, type TabItem } from '../../ui/Tabs.js';
import { tabIdOf, visibleHubRoutes } from '../../chrome/hubProjection.js';

/** Tab id (`tabIdOf`, the route path's last segment) → the page that tab shows.
 *  Every `hubTab: { hub: 'marketplace' }` route must have an entry (pinned by
 *  `marketplaceHub.test.tsx`); the tab LIST still projects from the manifest. */
export const PAGES: Record<string, ComponentType> = {
  bundles: lazy(() => import('./BundleShopPage.js').then((m) => ({ default: m.BundleShopPage }))),
  marketplace: lazy(() => import('./MarketplacePage.js').then((m) => ({ default: m.MarketplacePage }))),
  distribution: lazy(() => import('./DistributionComposerPage.js').then((m) => ({ default: m.DistributionComposerPage }))),
};

/** Tab id → the page's own lede key. */
const TAB_LEDE: Record<string, string> = {
  bundles: 'storeHeroLede',
  marketplace: 'lede',
  distribution: 'composerLede',
};

/** Every route in this console, ungated — which page a URL shows does not depend
 *  on whether its tab is visible (a toggled-off store still renders its own
 *  not-enabled state under the hub header). */
const HUB_ROUTES = FEATURES.filter((r) => r.hubTab?.hub === 'marketplace');

export function MarketplaceHub(): JSX.Element {
  const { t } = useTranslation(['marketplace', 'nav']);
  const isVisible = useFeatureVisible();
  const isAdmin = isAdminCaller(useEffectiveAccess());
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const routes = useMemo(() => visibleHubRoutes(FEATURES, isVisible, isAdmin, 'marketplace'), [isVisible, isAdmin]);
  const matches = (path: string): boolean => matchPath({ path, end: true }, pathname) !== null;
  const activeRoute = routes.find((r) => matches(r.path));
  const active = activeRoute ? tabIdOf(activeRoute) : '';
  const shownRoute = HUB_ROUTES.find((r) => matches(r.path));
  const Page = shownRoute ? PAGES[tabIdOf(shownRoute)] : undefined;

  const items: TabItem[] = routes.map((r) => {
    const id = tabIdOf(r);
    return { id, label: t(`hubTab_${id}`, { defaultValue: id }) };
  });
  // The one-line description of the ACTIVE tab rides the header lede (the shared
  // <Tabs> carries labels only). Each page's own lede, so the copy has one home.
  const ledeKey = TAB_LEDE[active];

  // The pane always renders EMBEDDED, so the hub's H1 is the page's only H1 —
  // including the loading / not-enabled states, where no tab is projected.
  // PANEL-level Suspense AND ErrorBoundary (ADR 0715 D1), keyed on the active tab
  // so a failed pane stays scoped to its tab and clears when the user moves on.
  const panel = (
    <ErrorBoundary resetKey={active} label={t('hubPanelRegion', { panel: items.find((item) => item.id === active)?.label ?? t('title') })}>
      <Suspense fallback={<StateCard loading title={t('common:loading')} />}>
        <HubProvider>{Page ? <Page /> : null}</HubProvider>
      </Suspense>
    </ErrorBoundary>
  );

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('nav:groupBillingCommerce')} title={t('title')} {...(ledeKey ? { lede: t(ledeKey) } : {})} />
      {activeRoute ? (
        <>
          <Tabs
            items={items}
            value={active}
            onChange={(id) => {
              const to = routes.find((r) => tabIdOf(r) === id)?.path;
              if (to && id !== active) navigate(to);
            }}
            label={t('hubTablistLabel')}
            idBase="marketplace"
            className="u-wrap"
          />
          <TabPanel idBase="marketplace" tabId={active}>{panel}</TabPanel>
        </>
      ) : panel}
    </section>
  );
}
