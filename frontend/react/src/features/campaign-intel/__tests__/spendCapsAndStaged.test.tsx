/**
 * ADR 0952 D2/D4 — the spend-caps panel and the staged alert action.
 *  - Caps: status chips with text, spent-of-limit in the cap's own currency
 *    (exponent-aware: JPY has no decimals), a create form that converts major →
 *    minor per currency, and an owner-only refusal shown in words.
 *  - Staged action: says what the action does, and confirming it calls the
 *    governed route (pause / propose) — the alert itself changed nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SpendCapDto } from '../campaignIntelClient.js';

const listSpendCaps = vi.fn();
const createSpendCap = vi.fn();
const setSpendCapLimit = vi.fn();
const pauseCampaign = vi.fn();
const proposeReallocationPlan = vi.fn();
vi.mock('../campaignIntelClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listSpendCaps: (orgId: string) => listSpendCaps(orgId),
  createSpendCap: (orgId: string, cap: unknown) => createSpendCap(orgId, cap),
  setSpendCapLimit: (...a: unknown[]) => setSpendCapLimit(...a),
  deleteSpendCap: vi.fn(),
  pauseCampaign: (orgId: string, campaignId: string) => pauseCampaign(orgId, campaignId),
  proposeReallocationPlan: (orgId: string) => proposeReallocationPlan(orgId),
}));

import { SpendCapsPanel } from '../SpendCapsPanel.js';
import { StagedAlertAction } from '../StagedAlertAction.js';

const CAP: SpendCapDto = {
  capId: 'cap-1', scope: { kind: 'client' }, limitMinor: 100_000, currency: 'JPY', period: 'calendar-month', maxStaleMinutes: 180, version: 1,
  state: { status: 'breached', spentMinor: 120_000, readAt: '2026-10-15T12:00:00.000Z', pausedTargets: [] },
};

beforeEach(() => { for (const f of [listSpendCaps, createSpendCap, setSpendCapLimit, pauseCampaign, proposeReallocationPlan]) f.mockReset(); });
afterEach(() => cleanup());

describe('SpendCapsPanel (ADR 0952 D2)', () => {
  it('shows status in words and money in the cap currency (JPY: no decimals)', async () => {
    listSpendCaps.mockResolvedValue([CAP]);
    render(<MemoryRouter><SpendCapsPanel orgId="org-1" campaigns={[]} /></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByText('Cap reached')).toBeTruthy();
    expect(screen.getByText(/¥120,000 of ¥100,000/)).toBeTruthy();
  });

  it('creates a cap converting major → minor per currency, and explains an owner-only refusal', async () => {
    listSpendCaps.mockResolvedValue([]);
    createSpendCap.mockResolvedValue(CAP);
    render(<MemoryRouter><SpendCapsPanel orgId="org-1" campaigns={[]} /></MemoryRouter>);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'kwd' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add cap' })); });
    expect(createSpendCap).toHaveBeenCalledWith('org-1', { scope: { kind: 'client' }, limitMinor: 12_500, currency: 'KWD', period: 'calendar-month' });

    listSpendCaps.mockResolvedValue([{ ...CAP, state: null }]);
    setSpendCapLimit.mockRejectedValue(new Error('Missing required scope: host:org:manage'));
    cleanup();
    render(<MemoryRouter><SpendCapsPanel orgId="org-1" campaigns={[]} /></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByText('Not read yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change limit' }));
    fireEvent.change(screen.getByLabelText('New limit (JPY)'), { target: { value: '200000' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(screen.getByText('Only the organization owner can raise or remove a cap.')).toBeTruthy();
  });
});

describe('StagedAlertAction (ADR 0952 D4)', () => {
  it('pause: explains it is ungated, confirms through the route, reports per-target results', async () => {
    pauseCampaign.mockResolvedValue({ results: [{ platform: 'meta', campaignId: '1', outcome: 'updated' }, { platform: 'google', campaignId: '2', outcome: 'failed', error: 'x' }] });
    render(<StagedAlertAction action="pause" orgId="org-1" campaignId="c1" campaignName="Summer" onProposed={() => {}} />);
    expect(screen.getByText(/Pause every ad platform campaign of “Summer”/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause campaign' })); });
    expect(pauseCampaign).toHaveBeenCalledWith('org-1', 'c1');
    expect(screen.getByText('Paused 1 platform campaign; 1 failed.')).toBeTruthy();
  });

  it('reallocate: proposes a plan (nothing applied) and refreshes the plans list', async () => {
    const onProposed = vi.fn();
    proposeReallocationPlan.mockResolvedValue({ outcome: 'proposed', plan: { ops: [{}, {}] } });
    render(<StagedAlertAction action="reallocate" orgId="org-1" onProposed={onProposed} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Propose a plan' })); });
    expect(screen.getByText('Plan proposed with 2 changes. Review it in the Inbox.')).toBeTruthy();
    expect(onProposed).toHaveBeenCalled();
  });
});
