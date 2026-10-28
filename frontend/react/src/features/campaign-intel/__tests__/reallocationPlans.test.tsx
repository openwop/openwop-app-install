/**
 * ADR 0952 D3 — the reallocation plans panel: renders nothing until a plan
 * exists; shows each change's before/after and outcome; applies a plan and says
 * honestly what happened (needs approval / applied / partly applied); hides the
 * one-click route's stamp-back records (history, not decisions).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReallocationPlanDto } from '../campaignIntelClient.js';

const listReallocations = vi.fn();
const applyReallocationPlan = vi.fn();
vi.mock('../campaignIntelClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listReallocations: (orgId: string) => listReallocations(orgId),
  applyReallocationPlan: (orgId: string, planId: string) => applyReallocationPlan(orgId, planId),
}));

import { ReallocationPlansPanel } from '../ReallocationPlansPanel.js';

const PLAN: ReallocationPlanDto = {
  planId: 'rp_1', source: { kind: 'optimizeBudget' }, status: 'proposed', approvalId: 'appr:1',
  ops: [
    { platform: 'meta', adAccountId: 'act_1', campaignId: '11', fromDailyMinor: 5000, toDailyMinor: 4000 },
    { platform: 'google', adAccountId: '1', campaignId: '21', fromDailyMinor: 2000, toDailyMinor: 3000 },
  ],
  dropped: [{ platform: 'meta', campaignId: '12', reason: 'budget_unreadable:http_500' }],
  results: [], createdAt: '2026-10-15T12:00:00.000Z', expiresAt: '2026-10-22T12:00:00.000Z',
};

const view = async (): Promise<void> => {
  render(<MemoryRouter><ReallocationPlansPanel orgId="org-1" /></MemoryRouter>);
  await act(async () => {});
};

beforeEach(() => { listReallocations.mockReset(); applyReallocationPlan.mockReset(); });
afterEach(() => cleanup());

describe('ReallocationPlansPanel (ADR 0952 D3)', () => {
  it('renders nothing with no plans, and ignores route stamp-backs', async () => {
    listReallocations.mockResolvedValue([{ ...PLAN, planId: 'rr_1', source: { kind: 'route' } }]);
    await view();
    expect(screen.queryByText('Budget reallocation plans')).toBeNull();
  });

  it('shows before/after, the change, what was left out, and the approval state', async () => {
    listReallocations.mockResolvedValue([PLAN]);
    await view();
    expect(screen.getByText('Budget reallocation plans')).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText('-20%')).toBeTruthy();
    expect(screen.getByText('+50%')).toBeTruthy();
    expect(screen.getByText(/Left out: 12: its current budget could not be read \(budget_unreadable:http_500\)/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review in Inbox' }).getAttribute('href')).toBe('/inbox');
  });

  it('apply: says when approval is still needed, and when the plan was only partly applied', async () => {
    listReallocations.mockResolvedValue([PLAN]);
    applyReallocationPlan.mockResolvedValueOnce({ outcome: 'requires_approval', plan: PLAN });
    await view();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply plan' })); });
    expect(applyReallocationPlan).toHaveBeenCalledWith('org-1', 'rp_1');
    expect(screen.getByText(/needs approval first/)).toBeTruthy();

    applyReallocationPlan.mockResolvedValueOnce({ outcome: 'partial', plan: { ...PLAN, status: 'partial' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply plan' })); });
    expect(screen.getByText(/Plan partly applied/)).toBeTruthy();
  });
});
