/**
 * UX_UPGRADE-usage-analytics UA-G1 — an unpriced model costs UNKNOWN, not $0.00.
 *
 * `computeCostUsd` returns `undefined` when the rate table has no entry for a
 * model. The rollup service collapsed that to `0` — under a docstring that
 * called it "honest: no fabricated cost" — and the dashboard then rendered
 * `f.currency(r.costUsd ?? 0)`.
 *
 * The intent was right and the conclusion was backwards: **0 IS a fabricated
 * cost**, and on a spend dashboard it is the one number that asserts the model
 * was FREE. A self-hosted or newly-added model with millions of tokens read as
 * costing nothing, and sorted as the cheapest row on the page.
 *
 * Breaks if: the unpriced cell renders a currency, the incomplete-cost warning
 * stops counting unpriced rows, unknown sorts as cheap, or a known cost is hidden
 * (probes w24g1-ua-unpriced-render / -warning-count / -unpriced-sort / -priced-render).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, within, fireEvent } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const { fetchUsageRollup, listOrgs, useFeatureAccess } = vi.hoisted(() => ({
  fetchUsageRollup: vi.fn(), listOrgs: vi.fn(), useFeatureAccess: vi.fn(),
}));
// Both come from usageAnalyticsClient — the page imports `listOrgs` from there,
// not from accessClient. Mocking the wrong module leaves the real one in place
// and the page renders with no data.
vi.mock('../../../client/usageAnalyticsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/usageAnalyticsClient.js')>()),
  fetchUsageRollup, listOrgs,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess,
}));

import { UsageDashboardPage } from '../UsageDashboardPage.js';
import type { UsageRollupRow } from '../../../client/usageAnalyticsClient.js';

const PRICED: UsageRollupRow = { provider: 'openai', model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000, calls: 10, costUsd: 12.5, updatedAt: '2026-01-01T00:00:00.000Z' };
const UNPRICED: UsageRollupRow = { provider: 'mystery', model: 'mystery-model-9000', inputTokens: 5_000_000, outputTokens: 5_000_000, calls: 99, updatedAt: '2026-01-01T00:00:00.000Z' };

/** Mount and wait until the rollup has RENDERED (a named model row), so absence
 *  assertions cannot pass against a page that has not loaded yet. */
const mount = async (model = 'mystery-model-9000'): Promise<void> => {
  render(<UsageDashboardPage />);
  await screen.findByText(model);
};
const costCell = (model: string): string | null => {
  const cells = within(screen.getByText(model).closest('tr')!).getAllByRole('cell');
  return cells[cells.length - 1]!.textContent;
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useFeatureAccess.mockReturnValue(makeFeatureAccess());
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  fetchUsageRollup.mockResolvedValue([PRICED, UNPRICED]);
});

describe('UA-G1 — unknown cost is not zero cost', () => {
  it('marks the unpriced row as unknown, in its own cost cell', async () => {
    await mount();
    // POSITIVE assertion, deliberately. A first version only asserted
    // `not.toContain('$0.00')` and SURVIVED the sabotage that restores the old
    // render — because `f.currency(undefined)` produces NaN, not "$0.00". The
    // absence of a wrong string is not the presence of a right one.
    const row = screen.getByText('mystery-model-9000').closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    expect(cells[cells.length - 1]!.textContent).toBe('—');
    expect(within(row).queryByText(/\$/)).toBeNull();
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('says the spend picture is incomplete', async () => {
    await mount();
    expect(document.body.textContent).toContain('no rate on file');
  });

  it('still shows a real cost for a priced model', async () => {
    // The failure mode of this fix is hiding costs we DO know.
    await mount();
    expect(costCell('gpt-4o')).toBe('$12.50');
  });

  it('says nothing about incompleteness when every model is priced', async () => {
    fetchUsageRollup.mockResolvedValue([PRICED]);
    await mount('gpt-4o');
    expect(document.body.textContent).not.toContain('no rate on file');
  });

  it('an unpriced row sorts to the END, not as the cheapest', async () => {
    // The other half of the fix, and it needed its own test: the sort sabotage
    // (`sortValue: r.costUsd ?? 0`) survived every assertion above, because
    // nothing here exercised ordering. Unknown must not masquerade as cheap.
    await mount();
    const header = screen.getByRole('button', { name: /Cost/i });
    await act(async () => { fireEvent.click(header); }); // ascending
    const modelCells = screen.getAllByRole('row').slice(1)
      .map((r) => within(r).getAllByRole('cell')[1]!.textContent);
    expect(modelCells[modelCells.length - 1]).toBe('mystery-model-9000');
  });

  it('a genuine zero cost is still rendered as zero', async () => {
    // A priced model with no tokens really did cost nothing — that is a fact,
    // not a fallback, and it must survive.
    fetchUsageRollup.mockResolvedValue([{ ...PRICED, inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 }]);
    await mount('gpt-4o');
    expect(costCell('gpt-4o')).toBe('$0.00');
    expect(document.body.textContent).not.toContain('no rate on file');
  });
});
