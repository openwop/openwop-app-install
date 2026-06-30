/**
 * Access Hub (ADR 0144) — one console for credentials & access.
 *
 * PROJECTS its tabs from the `FEATURES` manifest (`FEATURES.filter(r => r.hubTab)`)
 * — there is no second registry. Each tab is gated through the SAME
 * `useFeatureVisible()` predicate the nav rail uses, so a disabled toggle hides
 * the tab exactly as it hides a nav item (single-source gating).
 *
 * Reading `FEATURES` here is safe: this page is lazy-imported (`routes.tsx`), so
 * by the time it renders the manifest is fully composed — the dynamic import
 * breaks the static `chrome/features → registry → access-hub` edge (the
 * navigation-settings precedent). `routes.tsx` itself must NOT import FEATURES.
 *
 * The Workspace·Personal scope pill filters tabs by `hubTab.scopes` and is
 * carried into each body via HubProvider. Personal Keys is intentionally
 * absent (BYOK resolves tenant from the session, with no client scope param —
 * ADR 0144 OQ-5); Personal currently surfaces the caller's own Connections.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FEATURES } from '../../chrome/features.js';
import { HubProvider, type HubScope } from '../../chrome/hubContext.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Tabs, TabPanel, useUrlTab, type TabItem } from '../../ui/Tabs.js';
import { scopesOf, tabIdOf, visibleHubRoutes } from '../../chrome/hubProjection.js';

const SCOPES: HubScope[] = ['workspace', 'personal'];
/** Access Hub rail clusters (ADR 0144). */
const GROUP_ORDER = ['credentials', 'identity'];

export function AccessHubPage(): JSX.Element {
  const { t } = useTranslation('access-hub');
  const isVisible = useFeatureVisible();
  const [scope, setScope] = useUrlTab<HubScope>('scope', SCOPES, 'workspace');

  // Every hub route the caller may see (gated), independent of scope — used both
  // to build the scope pill (does Personal have anything?) and the section tabs.
  const visibleRoutes = useMemo(
    () => visibleHubRoutes(FEATURES, isVisible, 'access', GROUP_ORDER),
    [isVisible],
  );

  const hasPersonal = visibleRoutes.some((r) => scopesOf(r).includes('personal'));
  const routes = visibleRoutes.filter((r) => scopesOf(r).includes(scope));

  const ids = routes.map(tabIdOf);
  const [active, setActive] = useUrlTab('tab', ids, ids[0] ?? '');

  const items: TabItem[] = routes.map((r) => {
    const id = tabIdOf(r);
    return { id, label: t(`tab_${id}`, { defaultValue: r.nav?.label ?? id }) };
  });
  const scopeItems: TabItem<HubScope>[] = SCOPES.map((s) => ({ id: s, label: t(`scope_${s}`) }));
  const activeRoute = routes.find((r) => tabIdOf(r) === active);

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      {/* Scope pill — only when there's a Personal surface to switch to. */}
      {hasPersonal ? (
        <Tabs
          items={scopeItems}
          value={scope}
          onChange={setScope}
          label={t('scopeLabel')}
          idBase="access-scope"
          panelId="access-panel"
        />
      ) : null}

      {routes.length === 0 ? (
        <StateCard title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <>
          <Tabs
            items={items}
            value={active}
            onChange={setActive}
            label={t('tablistLabel')}
            idBase="access"
            className="u-wrap"
          />
          <TabPanel idBase="access" tabId={active}>
            {activeRoute ? (
              <HubProvider scope={scope}>{activeRoute.element}</HubProvider>
            ) : null}
          </TabPanel>
        </>
      )}
    </section>
  );
}
