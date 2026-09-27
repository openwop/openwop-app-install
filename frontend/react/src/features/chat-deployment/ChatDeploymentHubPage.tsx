/**
 * Chat deployment console (ADR 0145) — one destination for "how the AI chat
 * reaches people without someone in the seat": Scheduled runs (an agent chat on a
 * cadence) + Website widget (the chat embedded on a public site).
 *
 * PROJECTS its tabs from the `FEATURES` manifest
 * (`visibleHubRoutes(FEATURES, isVisible, 'chat-deployment')`) — no second
 * registry, the same single-source gating the nav rail uses. A flat console: no
 * scope pill (the Access Hub's Workspace·Personal axis has no meaning here).
 *
 * Reading `FEATURES` here is safe: the page is lazy-imported (`routes.tsx`), so by
 * render time the manifest is fully composed (the AccessHubPage precedent).
 * `routes.tsx` itself must NOT import FEATURES.
 *
 * @see docs/adr/0145-surface-rehoming-chat-and-platform-declutter.md
 */
import { Suspense, useMemo } from 'react';
import { ErrorBoundary } from '../../ui/index.js';
import { useTranslation } from 'react-i18next';
import { FEATURES } from '../../chrome/features.js';
import { HubProvider } from '../../chrome/hubContext.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { useEffectiveAccess, isAdminCaller } from '../../client/useEffectiveAccess.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Tabs, TabPanel, useUrlTab, type TabItem } from '../../ui/Tabs.js';
import { tabIdOf, visibleHubRoutes } from '../../chrome/hubProjection.js';

export function ChatDeploymentHubPage(): JSX.Element {
  const { t } = useTranslation('chat-deployment');
  const isVisible = useFeatureVisible();
  const isAdmin = isAdminCaller(useEffectiveAccess()); // AHC-1/MHC-1/CDC-1/CSCC-1 — gate admin-tier tabs

  const routes = useMemo(() => visibleHubRoutes(FEATURES, isVisible, isAdmin, 'chat-deployment'), [isVisible, isAdmin]);
  const ids = routes.map(tabIdOf);
  const [active, setActive] = useUrlTab('tab', ids, ids[0] ?? '');

  const items: TabItem[] = routes.map((r) => {
    const id = tabIdOf(r);
    return { id, label: t(`tab_${id}`, { defaultValue: r.nav?.label ?? id }) };
  });
  const activeRoute = routes.find((r) => tabIdOf(r) === active);

  return (
    <section className="u-grid u-gap-4" data-walkthrough="chat-deployment.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      {routes.length === 0 ? (
        <StateCard title={t('emptyTitle')} body={t('emptyBody')} />
      ) : routes.length === 1 ? (
        // One visible destination: a one-position switch is noise, not
        // structure — render the pane directly.
        <ErrorBoundary resetKey={tabIdOf(routes[0]!)} label={`chat deployment panel ${tabIdOf(routes[0]!)}`}>
          <Suspense fallback={<StateCard loading title={t('common:loading')} />}>
            <HubProvider>{routes[0]!.element}</HubProvider>
          </Suspense>
        </ErrorBoundary>
      ) : (
        <>
          <Tabs
            items={items}
            value={active}
            onChange={setActive}
            label={t('tablistLabel')}
            idBase="chat-deployment"
            className="u-wrap"
          />
          <TabPanel idBase="chat-deployment" tabId={active}>
            {/*
              PANEL-level Suspense AND ErrorBoundary — two different failure modes (ADR 0715).
              `<Suspense>` catches SUSPENSION while a lazy pane loads. It does NOT catch
              FAILURE: a rejected dynamic import is an error, so without a boundary here it
              unwinds to the page boundary (`App.tsx` / `SiteShell.tsx`) and replaces the WHOLE
              console — header and tab strip included. Worse, those boundaries key on
              `resetKey={location.pathname}` while hub tabs are a QUERY PARAM (`useUrlTab` ->
              `useSearchParams`), so the pathname never changes, the boundary never resets, and
              one broken tab wedges the page until a full reload. Hence `resetKey={active}`: a
              failed pane stays scoped to its own tab and clears when the user moves to a
              healthy one. Not hypothetical here — CLAUDE.md records that a frontend deploy
              PRUNES old assets while a stale shell is still served, which is exactly this.
              (This comment previously cited `settings-shell/SettingsPage.tsx:54` as already
              doing it "correctly". Wrong twice: the path is stale — it is
              `features/settings-shell/` — and that page had Suspense and ZERO ErrorBoundary,
              modelling only the suspension half. Four consoles were made to "agree" with it,
              which is how the error lane stayed open.)
            */}
            <ErrorBoundary resetKey={active} label={`chat deployment hub panel ${active}`}>
              <Suspense fallback={<StateCard loading title={t('common:loading')} />}>
                {activeRoute ? <HubProvider>{activeRoute.element}</HubProvider> : null}
              </Suspense>
            </ErrorBoundary>
          </TabPanel>
        </>
      )}
    </section>
  );
}
