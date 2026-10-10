/**
 * The Marketplace hub — one console over the feature store, the pack registry and
 * the white-label composer. It rides the SAME hub primitive as Models / Campaign
 * Studio / Chat deployment / Access (`hubTab` annotations projected through
 * `visibleHubRoutes`, the shared `<Tabs>`/`<TabPanel>`, `HubProvider`, a panel-level
 * Suspense + ErrorBoundary). The one difference is that its tabs are the routes'
 * own PATHS instead of `?tab=`, because those three URLs are already deep-linked
 * from nav lock links, locked-feature prompts and the Stripe return URLs.
 *
 * Locks: the projection (order, tier, toggle), the nav entry (one hub, buyer
 * placement, lights for every tab), the rendered chrome (tabs, active tab per
 * route, keyboard + focus across a tab navigation), and that query-string deep
 * links survive.
 *
 * Why: ADR 0820 §7 (one Marketplace console over store / packs / distribution),
 * riding the ADR 0144/0145 hub projection and the ADR 0715 D1 panel boundary.
 * Sabotage-witnessed (/grade-tests wave 10): a tab's `hubTab.order`, Distribution's
 * `tier`, the nav group and `activeFor`, the `HubProvider` wrap, the ungated
 * `HUB_ROUTES` page lookup, the tab-click `navigate`, the per-tab lede, a missing
 * `PAGES` entry and the lock-link path each red the section that claims them. The
 * "focus stays across the navigation" half of the keyboard case rests on every
 * route sharing one element type, which the projection case pins (`types.size`).
 */
import { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const visible = { on: true };
const admin = { on: true };
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../featureToggles/FeatureAccessContext.js')>();
  return { ...real, useFeatureVisible: () => (id?: string) => (id === 'marketplace' ? visible.on : true) };
});
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../client/useEffectiveAccess.js')>();
  return {
    ...real,
    useEffectiveAccess: () => (admin.on
      ? { roles: ['admin'], scopes: [], basis: 'tenant-owner' as const }
      : { roles: ['member'], scopes: [], basis: 'member' as const }),
  };
});

// The three real pages are stood in for by a pane that reports where it is and
// whether it renders embedded (their own behaviour is pinned in their own tests).
vi.mock('../BundleShopPage.js', () => ({ BundleShopPage: () => mockPane('store') }));
vi.mock('../MarketplacePage.js', () => ({ MarketplacePage: () => mockPane('packs') }));
vi.mock('../DistributionComposerPage.js', () => ({ DistributionComposerPage: () => mockPane('distribution') }));

import { FEATURES, NAV, featureFor, navItemIsActive } from '../../../chrome/features.js';
import { tabIdOf, visibleHubRoutes } from '../../../chrome/hubProjection.js';
import { useHub } from '../../../chrome/hubContext.js';
import { featureStoreHref } from '../../../featureToggles/lockedTargets.js';
import { bundleHref, COMPARE_HREF } from '../lockedUpsell.js';
import { MarketplaceHub, PAGES } from '../MarketplaceHub.js';

const HUB_PATHS = ['/marketplace/bundles', '/marketplace', '/marketplace/distribution'];

beforeEach(() => { visible.on = true; admin.on = true; });
afterEach(cleanup);

describe('Marketplace hub — projection from the FEATURES manifest', () => {
  it('projects Feature store → Packs → Distribution, in that order, for an admin with the toggle on', () => {
    const tabs = visibleHubRoutes(FEATURES, () => true, true, 'marketplace');
    expect(tabs.map((r) => r.path)).toEqual(HUB_PATHS);
    expect(tabs.map(tabIdOf)).toEqual(['bundles', 'marketplace', 'distribution']);
  });

  it('every tab keeps today\'s gate: admin tier + the `marketplace` toggle', () => {
    for (const r of visibleHubRoutes(FEATURES, () => true, true, 'marketplace')) {
      expect(r.tier, r.path).toBe('admin');
      expect(r.hubTab.featureId, r.path).toBe('marketplace');
    }
    // Toggle off: nothing to project.
    expect(visibleHubRoutes(FEATURES, (id) => id !== 'marketplace', true, 'marketplace')).toEqual([]);
  });

  it('a non-admin gets no tabs at all, Distribution included (the hub is admin-tier; AdminLayout denies the page)', () => {
    expect(visibleHubRoutes(FEATURES, () => true, false, 'marketplace')).toEqual([]);
  });

  it('every hub route has a page to render (the hub renders PAGES[tabId], not route.element)', () => {
    const ids = FEATURES.filter((r) => r.hubTab?.hub === 'marketplace').map(tabIdOf).sort();
    expect(Object.keys(PAGES).sort()).toEqual(ids);
    // ...and every route's element IS the hub, so a tab switch keeps it mounted.
    const types = new Set(FEATURES.filter((r) => r.hubTab?.hub === 'marketplace').map((r) => r.element.type));
    expect(types.size).toBe(1);
  });

  it('shares no tab with another console', () => {
    const others = (['access', 'models', 'chat-deployment', 'campaigns'] as const)
      .flatMap((h) => visibleHubRoutes(FEATURES, () => true, true, h).map((r) => r.path));
    for (const p of HUB_PATHS) expect(others).not.toContain(p);
  });
});

describe('Marketplace hub — one nav entry, placed for buyers', () => {
  const items = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.id })));
  const hits = items.filter((i) => HUB_PATHS.includes(i.to));

  it('exactly one nav entry, landing on the Feature store, in Billing & commerce', () => {
    expect(hits).toHaveLength(1);
    expect(hits[0]?.to).toBe('/marketplace/bundles');
    expect(hits[0]?.group).toBe('Billing & commerce');
    expect(hits[0]?.featureId).toBe('marketplace');
    expect(hits[0]?.labelKey).toBe('marketplaceLabel');
  });

  it('the entry lights on every tab of the hub (and nowhere else)', () => {
    const item = hits[0]!;
    for (const p of HUB_PATHS) expect(navItemIsActive(item, p), p).toBe(true);
    expect(navItemIsActive(item, '/billing')).toBe(false);
  });
});

describe('Marketplace hub — deep links keep resolving', () => {
  it('lock links, bundle/compare links and the hub paths all match a hub route', () => {
    for (const href of [featureStoreHref('crm'), featureStoreHref(), bundleHref('growth'), COMPARE_HREF, ...HUB_PATHS]) {
      const path = href.split('?')[0]!;
      expect(featureFor(path)?.hubTab?.hub, href).toBe('marketplace');
    }
  });
});

function mockPane(name: string): JSX.Element { return <Pane name={name} />; }

/** A pane that reports whether it is embedded, standing in for the real page. */
function Pane({ name }: { name: string }): JSX.Element {
  const { embedded } = useHub();
  const { search } = useLocation();
  return <p>{`pane:${name}:${embedded ? 'embedded' : 'standalone'}:${search}`}</p>;
}

function Where(): JSX.Element {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

const renderAt = (entry: string) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Suspense fallback={<div>loading</div>}>
      <Routes>
        <Route path="/marketplace/bundles" element={<MarketplaceHub />} />
        <Route path="/marketplace" element={<MarketplaceHub />} />
        <Route path="/marketplace/distribution" element={<MarketplaceHub />} />
      </Routes>
    </Suspense>
    <Where />
  </MemoryRouter>,
);

describe('Marketplace hub — rendered chrome', () => {
  it('admin: three tabs, Feature store first, with the hub H1', async () => {
    renderAt('/marketplace/bundles');
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Feature store', 'Packs', 'Distribution']);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Marketplace']);
  });

  it.each([
    ['/marketplace/bundles', 'Feature store', 'store'],
    ['/marketplace', 'Packs', 'packs'],
    ['/marketplace/distribution', 'Distribution', 'distribution'],
  ])('%s selects the %s tab and renders its page embedded', async (path, label, pane) => {
    renderAt(path);
    const selected = (await screen.findAllByRole('tab')).filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.map((t) => t.textContent)).toEqual([label]);
    // The pane is lazy behind a "Loading…" fallback, so the tabs can be in the
    // DOM before it resolves. Asserting synchronously raced that import and red
    // a loaded gate (2026-10-09, load 40: "expected 'Loading…' to contain
    // 'pane:distribution:embedded'"); it passed 3/3 alone. Wait for the pane.
    await waitFor(() => expect(screen.getByRole('tabpanel').textContent).toContain(`pane:${pane}:embedded`));
  });

  it('the lede describes the ACTIVE tab, not "browse signed packs" everywhere', async () => {
    renderAt('/marketplace/bundles');
    await screen.findAllByRole('tab');
    expect(document.body.textContent).not.toContain('Browse and install signed feature packs');
    cleanup();
    renderAt('/marketplace');
    await screen.findAllByRole('tab');
    expect(document.body.textContent).toContain('Browse and install signed feature packs');
  });

  it('clicking a tab navigates to its route', async () => {
    renderAt('/marketplace/bundles');
    fireEvent.click(await screen.findByRole('tab', { name: 'Packs' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/marketplace'));
    expect(screen.getByRole('tab', { name: 'Packs' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keyboard: arrows move focus, Enter activates, and focus stays on the tab across the navigation', async () => {
    renderAt('/marketplace/bundles');
    const store = await screen.findByRole('tab', { name: 'Feature store' });
    store.focus();
    fireEvent.keyDown(store, { key: 'ArrowRight' });
    const packs = screen.getByRole('tab', { name: 'Packs' });
    expect(document.activeElement).toBe(packs);
    fireEvent.click(packs); // Enter on a <button> = click (manual activation)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/marketplace'));
    expect(document.activeElement?.textContent).toBe('Packs');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
  });

  it('a query-string deep link (?feature=) reaches the page untouched', async () => {
    renderAt('/marketplace/bundles?feature=crm');
    await screen.findAllByRole('tab');
    // Same lazy-pane race as the it.each above: wait for the pane, not the tabs.
    await waitFor(() => expect(screen.getByRole('tabpanel').textContent).toContain('pane:store:embedded:?feature=crm'));
  });

  it('toggle off: no tab strip, the page still renders (its own not-enabled state) under the hub H1', async () => {
    visible.on = false;
    renderAt('/marketplace/bundles');
    await screen.findByText(/pane:store/);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Marketplace']);
  });

  it('non-admin: no tab strip (and so no Distribution tab)', async () => {
    admin.on = false;
    renderAt('/marketplace/bundles');
    await screen.findByText(/pane:store/);
    expect(screen.queryByRole('tab', { name: 'Distribution' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
