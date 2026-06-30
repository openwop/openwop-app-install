/**
 * Models console (ADR 0145) — one destination for "which model answers, and
 * which performs": Routing (rule-based provider/model selection) + Leaderboard
 * (model quality from feedback).
 *
 * PROJECTS its tabs from the `FEATURES` manifest
 * (`visibleHubRoutes(FEATURES, isVisible, 'models')`) — no second registry, the
 * same single-source gating the nav rail uses. A flat console: no scope pill (the
 * Access Hub's Workspace·Personal axis has no meaning here).
 *
 * Reading `FEATURES` here is safe: the page is lazy-imported (`routes.tsx`), so by
 * render time the manifest is fully composed (the AccessHubPage precedent).
 * `routes.tsx` itself must NOT import FEATURES.
 *
 * @see docs/adr/0145-surface-rehoming-chat-and-platform-declutter.md
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FEATURES } from '../../chrome/features.js';
import { HubProvider } from '../../chrome/hubContext.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Tabs, TabPanel, useUrlTab, type TabItem } from '../../ui/Tabs.js';
import { tabIdOf, visibleHubRoutes } from '../../chrome/hubProjection.js';

export function ModelsHubPage(): JSX.Element {
  const { t } = useTranslation('models');
  const isVisible = useFeatureVisible();

  const routes = useMemo(() => visibleHubRoutes(FEATURES, isVisible, 'models'), [isVisible]);
  const ids = routes.map(tabIdOf);
  const [active, setActive] = useUrlTab('tab', ids, ids[0] ?? '');

  const items: TabItem[] = routes.map((r) => {
    const id = tabIdOf(r);
    return { id, label: t(`tab_${id}`, { defaultValue: r.nav?.label ?? id }) };
  });
  const activeRoute = routes.find((r) => tabIdOf(r) === active);

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      {routes.length === 0 ? (
        <StateCard title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <>
          <Tabs
            items={items}
            value={active}
            onChange={setActive}
            label={t('tablistLabel')}
            idBase="models"
            className="u-wrap"
          />
          <TabPanel idBase="models" tabId={active}>
            {activeRoute ? <HubProvider>{activeRoute.element}</HubProvider> : null}
          </TabPanel>
        </>
      )}
    </section>
  );
}
