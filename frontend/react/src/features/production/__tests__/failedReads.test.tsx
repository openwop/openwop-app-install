/**
 * UX_UPGRADE-production PROD-G1 — three swallowed reads.
 *
 * `catch(() => setX([]))` is the most invisible form of this class: the failure
 * is discarded ENTIRELY and the page renders its empty state. All three empty
 * states here are INSTRUCTIVE — "Create an organization first", "Add
 * contractors…", "Ask the Production Planner…" — so a failed read told the user
 * to go and do work they may already have done, with no hint anything had gone
 * wrong.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs, listVendors, listPlans, useFeatureAccess } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listVendors: vi.fn(), listPlans: vi.fn(), useFeatureAccess: vi.fn(),
}));

vi.mock('../productionClient.js', async (orig) => ({
  ...(await orig<typeof import('../productionClient.js')>()),
  listOrgs, listVendors, listPlans,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess,
}));

import { MemoryRouter } from 'react-router-dom';
import { ProductionPage } from '../ProductionPage.js';

const ON = { status: 'on', enabled: true, isBeta: false, variant: null, entitled: true, locked: false, loading: false };

const mount = async (path = '/production'): Promise<void> => {
  render(<MemoryRouter initialEntries={[path]}><ProductionPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useFeatureAccess.mockReturnValue(ON);
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listVendors.mockResolvedValue([]);
  listPlans.mockResolvedValue([]);
});

describe('PROD-G1 — a failed read is not an empty result', () => {
  it('a failed org read does not tell you to create an organization', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.getByText('Could not load your organizations')).toBeTruthy();
  });

  it('a genuinely empty org list STILL says so', async () => {
    listOrgs.mockResolvedValue([]);
    await mount();
    // The shared `ui/OrgSelectionState` empty card: shared title + this
    // feature's own clause.
    expect(screen.getByText('No organizations')).toBeTruthy();
    expect(screen.getByText(/Vendors and production plans belong to an organization/i)).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('a failed vendor read does not claim the directory is empty', async () => {
    listVendors.mockRejectedValue(new Error('500'));
    await mount();
    expect(screen.queryByText('No vendors yet')).toBeNull();
    expect(screen.getByText('Could not load the vendor directory')).toBeTruthy();
  });

  it('a genuinely empty vendor directory STILL says so', async () => {
    await mount();
    expect(screen.getByText('No vendors yet')).toBeTruthy();
    expect(screen.queryByText('Could not load the vendor directory')).toBeNull();
  });

  it('a failed plan read does not claim there are no plans', async () => {
    listPlans.mockRejectedValue(new Error('500'));
    await mount('/production?tab=plans');
    expect(screen.queryByText('No production plans yet')).toBeNull();
    expect(screen.getByText('Could not load your production plans')).toBeTruthy();
  });

  it('a genuinely empty plan list STILL says so', async () => {
    await mount('/production?tab=plans');
    expect(screen.getByText('No production plans yet')).toBeTruthy();
  });

  it('retrying a failed vendor read recovers', async () => {
    listVendors.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce([]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(screen.getByText('No vendors yet')).toBeTruthy();
    expect(screen.queryByText('Could not load the vendor directory')).toBeNull();
  });
});
