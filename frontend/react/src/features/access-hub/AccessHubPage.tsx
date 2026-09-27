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
import { Suspense, useMemo } from 'react';
import { ErrorBoundary } from '../../ui/index.js';
import { useTranslation } from 'react-i18next';
import { FEATURES } from '../../chrome/features.js';
import { HubProvider, type HubScope } from '../../chrome/hubContext.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { useEffectiveAccess, isAdminCaller } from '../../client/useEffectiveAccess.js';
import { useAuth } from '../../auth/useAuth.js';
import { SignInButton } from '../../auth/SignInButton.js';
import { Notice } from '../../ui/Notice.js';
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
  const isAdmin = isAdminCaller(useEffectiveAccess()); // AHC-1 — gate admin-tier tabs in the projection itself
  const { user, loading: authLoading } = useAuth();
  const [scope, setScope] = useUrlTab<HubScope>('scope', SCOPES, 'workspace');

  // Every hub route the caller may see (gated), independent of scope — used both
  // to build the scope pill (does Personal have anything?) and the section tabs.
  const visibleRoutes = useMemo(
    () => visibleHubRoutes(FEATURES, isVisible, isAdmin, 'access', GROUP_ORDER),
    [isVisible, isAdmin],
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
    <section className="u-grid u-gap-4" data-walkthrough="access.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      {/* Anonymous sessions can browse the catalog, but connections + keys are
          wiped with the 24h demo tenant — say so and offer sign-in up front
          (same `user === null` predicate as the BYOK "Try it free" card). */}
      {!authLoading && user === null ? (
        <Notice variant="info">
          <div className="action-bar u-justify-between">
            <span>{t('anonSignInPrompt')}</span>
            <SignInButton />
          </div>
        </Notice>
      ) : null}

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
          <TabPanel idBase="access" tabId={active}>
            {activeRoute ? (
              <ErrorBoundary resetKey={active} label={t('panelRegion', { panel: items.find((item) => item.id === active)?.label ?? t('title') })}>
                <Suspense fallback={<StateCard loading title={t('common:loading')} />}>
                  <HubProvider scope={scope}>{activeRoute.element}</HubProvider>
                </Suspense>
              </ErrorBoundary>
            ) : null}
          </TabPanel>
        </>
      )}
    </section>
  );
}
