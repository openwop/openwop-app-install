/**
 * ADR 0145 follow-up — render coverage for a console shell (Models). The
 * manifest/projection logic is unit-tested in chrome/__tests__; this mounts the
 * real page to lock the runtime contract the projection tests can't see:
 *   - it projects its two tabs (Routing + Leaderboard) and renders the tablist,
 *   - switching tabs updates the selected tab,
 *   - mounted owner pages run EMBEDDED (their own <PageHeader> is suppressed, so
 *     the console owns the page chrome — no double header).
 *
 * The owner pages are `lazy()` in the FEATURES manifest, so the console subtree
 * suspends → the harness wraps a <Suspense> boundary and awaits with findBy*.
 * The owner pages' data clients are mocked so mounting them is inert.
 *
 * SETTLE BEFORE ABSENCE (wave 52 / grade-tests). Each "no duplicate header"
 * assertion waits for a signal the EMBEDDED owner page renders once it has
 * settled — the routing page's Organization picker, the leaderboard's zero-org
 * clause — so the absence is never read off a loading skeleton. The routing
 * fixture lists one org so the page reaches its main render, which is where a
 * non-embedded page shows its own header.
 * Sabotage: dropping `<HubProvider>` around the active owner page in
 * ModelsHubPage (the pages render non-embedded) reds the EMBEDDED and the
 * tab-switch cases (probe w52g1-mh-hubprovider).
 */
import { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ModelsHubPage gates tabs via useFeatureVisible; the mounted owner pages gate via
// useFeatureAccess. Allow all so both tabs project and both pages render.
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));
// The console is admin-tier and in the real app renders only behind <AdminLayout>,
// which mounts for admins alone. `visibleHubRoutes` now gates admin-tier tabs on the
// caller's admin authority (AHC-1/MHC-1/CDC-1), so the render test must present an
// admin caller — otherwise the projection correctly yields zero tabs. Keep the real
// `isAdminCaller`; only stand in an admin `EffectiveAccess`.
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../client/useEffectiveAccess.js')>();
  return { ...real, useEffectiveAccess: () => ({ roles: ['admin'], scopes: [], basis: 'tenant-owner' as const }) };
});
// Inert data layer for the two mounted owner pages.
vi.mock('../../../client/evalsClient.js', () => ({
  listOrgs: vi.fn().mockResolvedValue([]),
  fetchLeaderboard: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../model-router/modelRouterClient.js', () => ({
  // One org, so the routing page settles on its MAIN render (header + picker),
  // not the zero-org StateCard that has no header in either mode.
  listOrgs: vi.fn().mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]),
  getRouterConfig: vi.fn().mockResolvedValue(null),
  setRouterConfig: vi.fn(),
  setRouterEnabled: vi.fn(),
}));

import { ModelsHubPage } from '../ModelsHubPage.js';

const renderHub = () =>
  render(
    <MemoryRouter initialEntries={['/models']}>
      <Suspense fallback={<div>loading</div>}>
        <ModelsHubPage />
      </Suspense>
    </MemoryRouter>,
  );

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('ModelsHubPage (ADR 0145 console shell)', () => {
  it('renders the console header and projects exactly the Routing + Leaderboard tabs', async () => {
    renderHub();
    expect(await screen.findByRole('heading', { name: 'Models' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Routing', 'Leaderboard']);
  });

  it('mounts the active owner page EMBEDDED — no duplicate page header', async () => {
    renderHub();
    // model-router is the first tab; embedded, its own "Model routing" PageHeader
    // is suppressed (the console owns the chrome). Only the console title shows.
    expect(await screen.findByRole('heading', { name: 'Models' })).toBeTruthy();
    // Settled: the routing page's own picker is up (its main render).
    expect(await screen.findByLabelText('Organization')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Model routing' })).toBeNull();
  });

  it('switches the active tab on click', async () => {
    renderHub();
    const leaderboard = await screen.findByRole('tab', { name: 'Leaderboard' });
    expect(leaderboard.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(leaderboard);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Leaderboard' }).getAttribute('aria-selected')).toBe('true'),
    );
    // Leaderboard mounts embedded too — no "Model leaderboard" duplicate header.
    // Settled first: the leaderboard's zero-org clause (evals listOrgs → []).
    expect(await screen.findByText(/The model leaderboard belongs to an organization/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Model leaderboard' })).toBeNull();
  });
});
