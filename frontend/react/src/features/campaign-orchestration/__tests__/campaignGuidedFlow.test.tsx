/**
 * ADR 1154 D9 (P3) — the guided flow on the campaign page.
 *
 *   - with the guided toggle off, the page is the detail it was: no rail, no
 *     progress read, every section in one column, and a step in the URL changes
 *     nothing;
 *   - the guided flow needs BOTH toggles (`campaigns` and `campaigns.guided`);
 *   - on, the rail shows the six steps with the server's states, and "Next"
 *     links to the server's current step;
 *   - a waiting decision sends "Next" to Review wherever the campaign stands;
 *   - a step URL shows that step's sections only, and marks it current;
 *   - a failed progress read is a failure with a retry, never a rail of guesses.
 *
 * Sabotage: reading only `campaigns.guided` reds the both-toggles case; showing
 * every section on a step URL reds the step case; drawing the rail from the
 * campaign row on a failed read reds the failure case; linking "Next" to
 * `current` when a decision waits reds the waiting case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../CampaignLedgerSection.js', () => ({ CampaignLedgerSection: () => <div>ledger-section</div> }));
vi.mock('../autonomy/AutonomyPolicyPanel.js', () => ({ default: () => <div>policy-section</div> }));
vi.mock('../autonomy/VetoWindowsSection.js', () => ({ default: () => null }));
vi.mock('../CommandSection.js', () => ({ CommandSection: () => <div>command-section</div> }));
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CampaignLinks, MarketingCampaign } from '../campaignStudioClient.js';
import type { CampaignProgress, StepState } from '../progressClient.js';

const h = vi.hoisted(() => ({ getCampaignProgress: vi.fn(), visible: new Set<string>() }));
vi.mock('../campaignStudioClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCampaign: vi.fn(async () => CAMPAIGN),
  getCampaignLinks: vi.fn(async () => LINKS),
  listOrgs: vi.fn(async () => [{ orgId: 'org-a', name: 'Acme' }]),
  listDispatches: vi.fn(async () => []),
}));
vi.mock('../progressClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getCampaignProgress: h.getCampaignProgress }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useFeatureVisible: () => (id?: string) => !id || h.visible.has(id),
}));

import { CampaignDetailPage } from '../CampaignDetailPage.js';

const CAMPAIGN: MarketingCampaign = {
  id: 'cmp_a', tenantId: 't1', orgId: 'org-a', briefId: 'b1', name: 'Spring push', status: 'draft',
  channels: [], objective: 'Grow trials', personaIds: [], createdBy: 'u1',
  createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z',
};
const OK = { status: 'ok' as const, items: [] };
const LINKS: CampaignLinks = { products: OK, project: OK, assets: OK, runs: OK, emailSends: OK, adDispatches: OK, plans: OK, opsAssets: OK, assetTotal: 0 };

const progress = (states: [StepState, StepState, StepState, StepState, StepState, StepState], over: Partial<CampaignProgress> = {}): CampaignProgress => {
  const names = ['brief', 'plan', 'create', 'review', 'launch', 'measure'] as const;
  return {
    campaignId: 'cmp_a', status: 'draft', current: 'plan', next: 'set-goal',
    steps: names.map((step, i) => ({ step, state: states[i] as StepState })),
    detail: { preflight: { status: 'unknown' }, plans: { status: 'unavailable' }, reviewWindows: { status: 'ok', value: { count: 0 } }, runs: { status: 'ok', value: { count: 0 } } },
    ...over,
  };
};

function open(path = '/campaign-studio/campaigns/cmp_a'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/campaign-studio/campaigns/:campaignId" element={<CampaignDetailPage />} />
        <Route path="/campaign-studio/campaigns/:campaignId/:step" element={<CampaignDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
const stepLinks = (): Array<string | null> => screen.getAllByRole('link').filter((a) => a.closest('.step-rail')).map((a) => a.textContent);

beforeEach(() => {
  h.getCampaignProgress.mockReset();
  h.getCampaignProgress.mockResolvedValue(progress(['done', 'in-progress', 'not-started', 'not-started', 'not-started', 'not-started']));
  h.visible.clear();
});
afterEach(cleanup);

describe('ADR 1154 D9 — the guided flow on the campaign page', () => {
  it('off: no rail, no progress read, every section, and a step URL changes nothing', async () => {
    h.visible.add('campaigns');
    open('/campaign-studio/campaigns/cmp_a/review');
    expect(await screen.findByRole('heading', { name: 'Spring push' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Campaign steps' })).toBeNull();
    expect(h.getCampaignProgress).not.toHaveBeenCalled();
    expect(screen.getByText('Grow trials')).toBeTruthy();
    expect(screen.getByText('ledger-section')).toBeTruthy();
    expect(await screen.findByText('command-section')).toBeTruthy();
    expect(await screen.findByText('policy-section')).toBeTruthy();
  });

  it('needs both toggles: the guided toggle alone shows no rail', async () => {
    h.visible.add('campaigns.guided');
    open();
    expect(await screen.findByRole('heading', { name: 'Spring push' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Campaign steps' })).toBeNull();
    expect(h.getCampaignProgress).not.toHaveBeenCalled();
  });

  it('on: the rail shows the six steps with the server states, and Next links to the current step', async () => {
    h.visible.add('campaigns'); h.visible.add('campaigns.guided');
    open();
    expect(await screen.findByRole('navigation', { name: 'Campaign steps' })).toBeTruthy();
    expect(stepLinks()).toEqual(['1BriefDone', '2PlanIn progress', '3CreateNot started', '4ReviewNot started', '5LaunchNot started', '6MeasureNot started']);
    expect(h.getCampaignProgress).toHaveBeenCalledWith('cmp_a');
    expect(screen.getByRole('link', { name: 'Set the goal' }).getAttribute('href')).toBe('/campaign-studio/campaigns/cmp_a/plan');
    // The overview: the campaign's facts, and no step's sections.
    expect(screen.getByText('Grow trials')).toBeTruthy();
    expect(screen.queryByText('ledger-section')).toBeNull();
    expect(screen.queryByText('command-section')).toBeNull();
  });

  it('a waiting decision sends Next to Review, wherever the campaign stands', async () => {
    h.visible.add('campaigns'); h.visible.add('campaigns.guided');
    const p = progress(['done', 'in-progress', 'not-started', 'needs-you', 'not-started', 'not-started'], { current: 'plan', next: 'review-waiting' });
    p.steps[3] = { step: 'review', state: 'needs-you', waiting: 2 };
    h.getCampaignProgress.mockResolvedValue(p);
    open();
    expect((await screen.findByRole('link', { name: 'Decide what is waiting' })).getAttribute('href')).toBe('/campaign-studio/campaigns/cmp_a/review');
    expect(screen.getByText(/Waiting for a decision: 2/)).toBeTruthy();
  });

  it('a step URL shows that step only, and marks it current', async () => {
    h.visible.add('campaigns'); h.visible.add('campaigns.guided');
    open('/campaign-studio/campaigns/cmp_a/measure');
    expect(await screen.findByText('ledger-section')).toBeTruthy();
    expect(screen.queryByText('Grow trials')).toBeNull();
    expect(screen.queryByText('command-section')).toBeNull();
    expect(screen.queryByText('policy-section')).toBeNull();
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'step');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/campaign-studio/campaigns/cmp_a/measure']);
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe('/campaign-studio/campaigns/cmp_a');
  });

  it('a failed progress read is a failure with a retry, never a rail', async () => {
    h.visible.add('campaigns'); h.visible.add('campaigns.guided');
    h.getCampaignProgress.mockRejectedValueOnce(new Error('unavailable'));
    open();
    expect(await screen.findByText('Could not read where this campaign stands.')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Campaign steps' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('navigation', { name: 'Campaign steps' })).toBeTruthy();
  });
});
