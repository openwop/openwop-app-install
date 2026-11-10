/**
 * ADR 0357 PERF-3 — the goal planner must never put a previous client's money or
 * results under the newly selected client. The real CampaignIntelPage runs; only
 * the client transport is stubbed (typed against its exported shapes).
 *
 * Two guard pairs hold this, by design:
 *  - a COMPLETED plan/error is hidden after a switch by BOTH the render scope
 *    (`planner.orgId === orgId`) and the `[orgId]` effect's `setPlanner(null)`;
 *    either alone suffices (each single-half probe is vacuous), so the probe
 *    breaks both at once.
 *  - a LATE response is dropped by `ownsRequest` = request sequence AND org. The
 *    effect bumps the sequence on every org change, so the org half is redundant
 *    on every reachable path (its single probe is vacuous); the probe breaks both.
 *
 * Red when (sabotage-witnessed, w93): the drafts are not reset on a switch; both
 * render scope and effect reset are dropped; `ownsRequest` always owns (or the
 * sequence half is dropped); a stale request's `finally` clears the busy state.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Anomaly, AttributionReport, BudgetPlanDto, CampaignForecast, BudgetRecommendation, OrgRef, PacingReport } from '../campaignIntelClient.js';

const planBudget = vi.fn();
vi.mock('../campaignIntelClient.js', async orig => ({
  ...await orig<Record<string, unknown>>(),
  listOrgs: vi.fn(async (): Promise<OrgRef[]> => [{ orgId: 'client-a', name: 'Client A' }, { orgId: 'client-b', name: 'Client B' }]),
  getBudget: vi.fn(async (orgId: string): Promise<BudgetRecommendation> => orgId === 'client-a'
    ? { note: 'Client A overview', totalSpend: 200, projectedRoasGain: 0, reallocations: [{ platform: 'google', currentSpend: 100, suggestedSpend: 140, changeAmount: 40, changePercent: 40, reason: 'Controlled metrics', roas: 5 }] }
    : { note: '', totalSpend: 0, projectedRoasGain: 0, reallocations: [] }),
  getForecast: vi.fn(async (): Promise<CampaignForecast[]> => []), getAnomalies: vi.fn(async (): Promise<Anomaly[]> => []),
  getAttribution: vi.fn(async (): Promise<AttributionReport> => ({ rows: [], email: [], unattributedConversions: 0, currency: 'USD', currencyMixed: false, computedAt: '2026-11-05T00:00:00Z' })),
  getPacing: vi.fn(async (): Promise<PacingReport> => ({ rows: [], unplanned: 0, computedAt: '2026-11-05T00:00:00Z' })),
  planBudget: (...args: unknown[]) => planBudget(...args),
}));
vi.mock('../MultiTouchSection.js', () => ({ MultiTouchSection: () => null }));
vi.mock('../ReconciliationSection.js', () => ({ ReconciliationSection: () => null }));
vi.mock('../AdMapSection.js', () => ({ AdMapSection: () => null }));
vi.mock('../ReallocationPlansPanel.js', () => ({ ReallocationPlansPanel: () => null }));
vi.mock('../SpendCapsPanel.js', () => ({ SpendCapsPanel: () => null }));
import { CampaignIntelPage } from '../CampaignIntelPage.js';

function deferred() {
  let resolve!: (value: { plan: BudgetPlanDto }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ plan: BudgetPlanDto }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function plan(note: string): BudgetPlanDto {
  return { verdict: 'stretch', impliedCpaMinor: 1163, expectedConversions: 86, confidence: 'medium', note,
    platforms: [{ platform: 'google', allocationMinor: 100000, expectedConversions: 86, historicalCpaMinor: 1163 }],
    pacing: [{ week: 1, budgetMinor: 25000, expectedConversions: 22 }] };
}
async function view() {
  render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
  await screen.findByRole('button', { name: 'Plan' });
}
function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Total budget'), { target: { value: '1000' } });
  fireEvent.change(screen.getByLabelText('Target conversions'), { target: { value: '100' } });
  fireEvent.change(screen.getByLabelText('Days'), { target: { value: '28' } });
  const form = screen.getByLabelText('Total budget').closest('form');
  if (!form) throw new Error('Actual planner form must exist');
  fireEvent.submit(form);
}
async function selectClient(id: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), { target: { value: id } });
  await screen.findByLabelText('Total budget');
  await waitFor(() => expect(screen.getByText(id === 'client-a' ? 'Client A overview' : 'Not enough data yet')).toBeTruthy());
}
function submitDisabled(): boolean {
  const form = screen.getByLabelText('Total budget').closest('form');
  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) throw new Error('Actual planner submit must exist');
  return button.disabled;
}
beforeEach(() => { planBudget.mockReset(); });
afterEach(cleanup);

it('clears completed result, pacing and client-specific form drafts on organization change', async () => {
  planBudget.mockResolvedValue({ plan: plan('Client A plan') });
  await view(); fillAndSubmit();
  await screen.findByText('Client A plan');
  expect(screen.getByRole('heading', { name: 'Weekly pacing' })).toBeTruthy();
  expect(planBudget).toHaveBeenCalledWith('client-a', { totalBudgetMinor: 100000, targetConversions: 100, horizonDays: 28 });
  await selectClient('client-b');
  expect(screen.queryByText('Client A plan')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Weekly pacing' })).toBeNull();
  expect((screen.getByLabelText('Total budget') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Target conversions') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Days') as HTMLInputElement).value).toBe('90');
});

it.each(['success', 'error'] as const)('ignores old client %s and finally while the new client plan is pending', async outcome => {
  const old = deferred(); const current = deferred();
  planBudget.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await view(); fillAndSubmit(); await selectClient('client-b'); fillAndSubmit();
  await act(async () => { if (outcome === 'success') old.resolve({ plan: plan('Obsolete A plan') }); else old.reject(new Error('Obsolete A error')); });
  expect(screen.queryByText('Obsolete A plan')).toBeNull();
  expect(screen.queryByText('Obsolete A error')).toBeNull();
  expect(submitDisabled()).toBe(true);
  await act(async () => current.resolve({ plan: plan('Current B plan') }));
  expect(screen.getByText('Current B plan')).toBeTruthy();
  expect(submitDisabled()).toBe(false);
});

it('ignores an older same-client request without clearing the current busy state', async () => {
  const old = deferred(); const current = deferred();
  planBudget.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await view(); fillAndSubmit(); fillAndSubmit();
  await act(async () => old.resolve({ plan: plan('Older same-client plan') }));
  expect(screen.queryByText('Older same-client plan')).toBeNull();
  expect(submitDisabled()).toBe(true);
  await act(async () => current.resolve({ plan: plan('Newest same-client plan') }));
  expect(screen.getByText('Newest same-client plan')).toBeTruthy();
});

it('does not revive the first client request after switching away and back', async () => {
  const old = deferred(); const current = deferred();
  planBudget.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await view(); fillAndSubmit(); await selectClient('client-b'); await selectClient('client-a'); fillAndSubmit();
  await act(async () => current.resolve({ plan: plan('New A plan') }));
  await act(async () => old.reject(new Error('First A request error')));
  expect(screen.getByText('New A plan')).toBeTruthy();
  expect(screen.queryByText('First A request error')).toBeNull();
});

it('clears a completed client-specific error on scope change', async () => {
  planBudget.mockRejectedValue(new Error('Client A planner unavailable'));
  await view(); fillAndSubmit();
  await screen.findByText('Client A planner unavailable');
  await selectClient('client-b');
  expect(screen.queryByText('Client A planner unavailable')).toBeNull();
});
