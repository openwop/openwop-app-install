/**
 * UX_UPGRADE-campaign-orchestration — ORCH-G1 / ORCH-G2.
 *
 *  - ORCH-G1: the delete confirm carefully named the HARMLESS consequence ("the
 *    brief it came from is untouched") while omitting the consequential one.
 *    `deleteCampaign` clears asset usage, drops versions and fires the sibling
 *    prune seam — it never touches the ad platform. So real, paused Meta/Google
 *    campaigns survive the delete, now unreachable from this app.
 *  - ORCH-G2: the dispatch ledger row carries the platform-side name, the DAILY
 *    BUDGET, the ad account and the dispatch time. All four were dropped,
 *    leaving an opaque platform id as the only fact about a live ad object.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdDispatch, MarketingCampaign } from '../campaignStudioClient.js';

const listCampaigns = vi.fn();
const listDispatches = vi.fn();

vi.mock('../campaignStudioClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listCampaigns: () => listCampaigns(),
    listDispatches: (...a: unknown[]) => listDispatches(...a),
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBriefs: vi.fn(async () => []),
    deleteCampaign: vi.fn(async () => {}),
    updateCampaign: vi.fn(async () => ({})),
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignStudioPage } from '../CampaignStudioPage.js';

const CAMPAIGN: MarketingCampaign = {
  id: 'camp-1', name: 'Spring push', status: 'active', channels: ['ad_variants'], objective: 'Grow trials',
} as MarketingCampaign;

const DISPATCH: AdDispatch = {
  platform: 'meta', platformCampaignId: 'mc-999', platformAdSetId: 'as-1', platformAdId: 'ad-1',
  campaignName: 'Spring push — Meta', dailyBudgetMinor: 250000, adAccountId: 'act_123456',
  createdAt: '2026-07-02T09:30:00.000Z',
};

async function openDetail(): Promise<void> {
  render(<MemoryRouter><CampaignStudioPage /></MemoryRouter>);
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: /spring push/i }));
  await screen.findByText(/Launch|launch/i);
}

beforeEach(() => {
  listCampaigns.mockReset(); listDispatches.mockReset();
  listCampaigns.mockResolvedValue([CAMPAIGN]);
  listDispatches.mockResolvedValue([DISPATCH]);
});
afterEach(cleanup);

describe('ORCH-G2: the dispatch ledger shows the facts it already has', () => {
  it('shows the DAILY BUDGET of the live ad campaign, as labeled minor units', async () => {
    await openDetail();
    // R2 review fold-in: the ledger carries no currency, so the amount renders
    // as RAW minor units and says so — the old `/100` assumed 2-decimal
    // currencies and showed a JPY-class budget 100× low.
    expect(await screen.findByText(/Daily budget 250,000 minor units/)).toBeTruthy();
    expect(screen.queryByText(/Daily budget 2,500\b/)).toBeNull();
  });

  it('shows the platform-side name, the ad account and when it was dispatched', async () => {
    await openDetail();
    expect(await screen.findByText('Spring push — Meta')).toBeTruthy();
    expect(screen.getByText(/act_123456/)).toBeTruthy();
    expect(screen.getByText(/Dispatched/)).toBeTruthy();
    // The platform id is still there — it just isn't the ONLY thing there.
    expect(screen.getByText('mc-999')).toBeTruthy();
  });

  it('a row missing the optional fields still renders, without blanks', async () => {
    listDispatches.mockResolvedValue([{
      platform: 'google', platformCampaignId: 'gc-1', platformAdSetId: 'gs-1', platformAdId: 'ga-1',
      createdAt: '2026-07-02T09:30:00.000Z',
    } satisfies AdDispatch]);
    await openDetail();
    expect(await screen.findByText('gc-1')).toBeTruthy();
    // No budget was recorded, so none is claimed.
    expect(screen.queryByText(/Daily budget/)).toBeNull();
  });
});

describe('ORCH-G1: deleting discloses what survives on the ad platform', () => {
  it('the confirm says the dispatched platform campaigns stay put', async () => {
    render(<MemoryRouter><CampaignStudioPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    const text = dialog.textContent ?? '';
    // The consequential fact, not just the reassuring one.
    expect(text).toMatch(/stay on the platform/i);
    expect(text).toMatch(/removed there/i);
    // The reassurance about the brief is still there — this adds, not replaces.
    expect(text).toMatch(/brief it came from is untouched/i);
  });

  it('the confirm still states irreversibility', async () => {
    render(<MemoryRouter><CampaignStudioPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be undone/i)).toBeTruthy();
  });
});
