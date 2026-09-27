/**
 * CC-R2-1 / CI-R2-1 (campaign cluster round 2) — the "no organization"
 * invitation must never ride a failed orgs read.
 *
 * `listOrgs().catch(() => {})` + an `orgs.length === 0 → noOrgTitle` branch —
 * the BRAND-R2-1 shape — recurred on BOTH campaign-connectors and
 * campaign-intel. One test file pins the shape on both pages (the cluster
 * shares the pattern; the fix is byte-identical).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const cc = vi.hoisted(() => ({ listOrgs: vi.fn(), getKpi: vi.fn() }));
vi.mock('../campaignConnectorsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual, listOrgs: cc.listOrgs, getKpi: cc.getKpi,
    // R2 review m4 — never leave the new fns as real jsdom fetches.
    getSyncStatus: vi.fn(async () => []),
    listPixels: vi.fn(async () => []),
    listConversions: vi.fn(async () => []),
  };
});
const ci = vi.hoisted(() => ({ listOrgs: vi.fn() }));
vi.mock('../../campaign-intel/campaignIntelClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, listOrgs: ci.listOrgs };
});

import { CampaignConnectorsPage } from '../CampaignConnectorsPage.js';
import { CampaignIntelPage } from '../../campaign-intel/CampaignIntelPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  // R2 CC-SP-16 — the old `null` here was an impossible wire shape; a real
  // empty summary keeps these org-lane tests honest about the page they mount.
  cc.getKpi.mockResolvedValue({
    totals: { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, ctr: 0, cpc: 0, cvr: 0, cpa: 0, roas: 0 },
    byPlatform: [], recordCount: 0, dateRange: null, currency: 'USD',
  });
});
afterEach(cleanup);

describe('CC-R2-1 — campaign-connectors', () => {
  it('FAILED orgs read shows the load-failure card, not the no-org claim', async () => {
    cc.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<MemoryRouter><CampaignConnectorsPage /></MemoryRouter>);
    expect(await screen.findByText(/Could not load this/i)).toBeTruthy();
    expect(screen.queryByText(/no organization/i)).toBeNull();
  });

  it('TRUTHFUL org-less tenant still gets the real no-org state', async () => {
    cc.listOrgs.mockResolvedValue([]);
    render(<MemoryRouter><CampaignConnectorsPage /></MemoryRouter>);
    expect(await screen.findByText(/organization/i, { selector: '.state-card__title' })).toBeTruthy();
    expect(screen.queryByText(/Could not load this/i)).toBeNull();
  });
});

describe('CI-R2-1 — campaign-intel', () => {
  it('FAILED orgs read shows the load-failure card, not the no-org claim', async () => {
    ci.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    expect(await screen.findByText(/Could not load this/i)).toBeTruthy();
    expect(screen.queryByText(/no organization/i)).toBeNull();
  });

  it('TRUTHFUL org-less tenant still gets the real no-org state', async () => {
    ci.listOrgs.mockResolvedValue([]);
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    expect(await screen.findByText(/organization/i, { selector: '.state-card__title' })).toBeTruthy();
    expect(screen.queryByText(/Could not load this/i)).toBeNull();
  });
});
