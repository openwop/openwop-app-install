/**
 * UX_UPGRADE-production PROD-G1 — three swallowed reads.
 *
 * `catch(() => setX([]))` is the most invisible form of this class: the failure
 * is discarded ENTIRELY and the page renders its empty state. All three empty
 * states here are INSTRUCTIVE — "Create an organization first", "Add
 * contractors…", "Ask the Production Planner…" — so a failed read told the user
 * to go and do work they may already have done, with no hint anything had gone
 * wrong.
 *
 * Sabotage-witnessed (w52): each `setXFailed(true)` dropped from its catch, the
 * org-failure flag not passed to OrgSelectionState, the vendor Retry a no-op.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

type Client = typeof import('../productionClient.js');
const { listOrgs, listVendors, listPlans, useFeatureAccess } = vi.hoisted(() => ({
  listOrgs: vi.fn<Client['listOrgs']>(), listVendors: vi.fn<Client['listVendors']>(), listPlans: vi.fn<Client['listPlans']>(),
  useFeatureAccess: vi.fn<typeof import('../../../featureToggles/FeatureAccessContext.js')['useFeatureAccess']>(),
}));

vi.mock('../productionClient.js', async (orig) => ({
  ...(await orig<Client>()),
  listOrgs, listVendors, listPlans,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess,
}));

import { MemoryRouter } from 'react-router-dom';
import { ProductionPage } from '../ProductionPage.js';

// w52: each case now waits for its own settle signal (the text it asserts)
// instead of one `act` flush, which raced the chained org → vendors read.
const mount = (path = '/production'): void => {
  render(<MemoryRouter initialEntries={[path]}><ProductionPage /></MemoryRouter>);
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }));
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listVendors.mockResolvedValue([]);
  listPlans.mockResolvedValue([]);
});

describe('PROD-G1 — a failed read is not an empty result', () => {
  it('a failed org read does not tell you to create an organization', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    mount();
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
  });

  it('a genuinely empty org list STILL says so', async () => {
    listOrgs.mockResolvedValue([]);
    mount();
    // The shared `ui/OrgSelectionState` empty card: shared title + this
    // feature's own clause.
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText(/Vendors and production plans belong to an organization/i)).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('a failed vendor read does not claim the directory is empty', async () => {
    listVendors.mockRejectedValue(new Error('500'));
    mount();
    expect(await screen.findByText('Could not load the vendor directory')).toBeTruthy();
    expect(screen.queryByText('No vendors yet')).toBeNull();
  });

  it('a genuinely empty vendor directory STILL says so', async () => {
    mount();
    expect(await screen.findByText('No vendors yet')).toBeTruthy();
    expect(screen.queryByText('Could not load the vendor directory')).toBeNull();
  });

  it('a failed plan read does not claim there are no plans', async () => {
    listPlans.mockRejectedValue(new Error('500'));
    mount('/production?tab=plans');
    expect(await screen.findByText('Could not load your production plans')).toBeTruthy();
    expect(screen.queryByText('No production plans yet')).toBeNull();
  });

  it('a genuinely empty plan list STILL says so', async () => {
    mount('/production?tab=plans');
    expect(await screen.findByText('No production plans yet')).toBeTruthy();
    expect(screen.queryByText('Could not load your production plans')).toBeNull();
  });

  it('retrying a failed vendor read recovers', async () => {
    listVendors.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce([]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No vendors yet')).toBeTruthy();
    expect(screen.queryByText('Could not load the vendor directory')).toBeNull();
    expect(listVendors).toHaveBeenCalledTimes(2);
  });
});
