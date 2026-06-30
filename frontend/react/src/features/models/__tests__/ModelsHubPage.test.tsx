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
 */
import { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ModelsHubPage gates tabs via useFeatureVisible; the mounted owner pages gate via
// useFeatureAccess. Allow all so both tabs project and both pages render.
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureAccess: () => ({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));
// Inert data layer for the two mounted owner pages.
vi.mock('../../../client/evalsClient.js', () => ({
  listOrgs: vi.fn().mockResolvedValue([]),
  fetchLeaderboard: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../model-router/modelRouterClient.js', () => ({
  listOrgs: vi.fn().mockResolvedValue([]),
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
    expect(screen.queryByRole('heading', { name: 'Model leaderboard' })).toBeNull();
  });
});
