/**
 * Usage analytics R2 — the ROLLUP read (not the org read) and the org-switch race.
 *
 * `orgsFailedGuard.test.tsx` covers a failed ORGANIZATION read. This file covers
 * the read one level down, which was still dishonest, plus the race that
 * misattributes numbers between organizations.
 *
 * UA-R2-1 — A FAILED ROLLUP RENDERED A POSITIVE FALSEHOOD. On rejection `rows`
 * stayed `null` and `error` was set, so the page's `rows === null && !error`
 * guard went FALSE, the else-branch ran, and `visibleRows` — `(rows ?? [])` —
 * was empty. `DataTable` renders its `empty` slot at length 0, so the page
 * printed "No usage recorded yet." beneath the error: a read that never
 * completed, asserting there is nothing to report. On a COST dashboard that is
 * the difference between "you spent nothing" and "we don't know what you spent".
 *
 * Worth naming precisely, because it is why the repo's ratchet was green: the
 * empty was manufactured at RENDER by the `?? []` coalesce, not written into
 * state by the catch. `check-failed-read-sentinels.mjs` greps the catch
 * (`.catch(() => setX([]))`) and structurally cannot see this shape.
 *
 * UA-R2-2 — NO STALENESS GUARD. `load()` had no sequence token, so switching
 * org A→B rendered A's rollup under B's name whenever A resolved last. Silent:
 * the numbers are real, just attributed to the wrong organization.
 *
 * Both polarities are asserted throughout — an "absent" assertion on its own is
 * vacuous, since a component that rendered nothing at all would satisfy it.
 *
 * Breaks if: the failed rollup falls back to the table/empty branch, Retry stops
 * re-running the read, or the sequence token stops guarding the write (probes
 * w24g1-ua-failed-state / -retry-noop / -seq-guard, /grade-tests wave 24).
 *
 * Cut in wave 24: the "UA-G1 must not regress" block. Its unpriced case was a weaker
 * duplicate of unpricedCost.test.tsx (its `$0.00` absence survived restoring the old
 * render, which prints `$NaN`); its UA-R2-4 case could not fail — `unpricedCount` is
 * derived from `rows ?? []`, so while `rows === null` the `rows !== null &&` guard
 * is a structurally redundant double guard (sabotage w24g1-ua-warning-null-guard:
 * vacuous). Honest ceiling recorded; the warning itself is pinned in unpricedCost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent, act } from '@testing-library/react';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));
vi.mock('../../../client/usageAnalyticsClient.js', () => ({ listOrgs: vi.fn(), fetchUsageRollup: vi.fn() }));

import { listOrgs, fetchUsageRollup, type UsageRollupRow } from '../../../client/usageAnalyticsClient.js';
import { UsageDashboardPage } from '../UsageDashboardPage.js';

const mockOrgs = vi.mocked(listOrgs);
const mockRollup = vi.mocked(fetchUsageRollup);

const ORG_A = { orgId: 'org-a', name: 'Alpha' };
const ORG_B = { orgId: 'org-b', name: 'Beta' };

const row = (over: Partial<UsageRollupRow> = {}): UsageRollupRow => ({
  provider: 'anthropic', model: 'claude-opus-5',
  inputTokens: 1000, outputTokens: 500, calls: 3, costUsd: 1.25,
  updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

beforeEach(() => { mockOrgs.mockReset(); mockRollup.mockReset(); });
afterEach(cleanup);

describe('UA-R2-1 — a failed rollup is a failure, never "no usage"', () => {
  it('rollup REJECTS: announced retryable card, and NOT the empty claim', async () => {
    mockOrgs.mockResolvedValue([ORG_A]);
    mockRollup.mockRejectedValue(new Error('boom'));
    render(<UsageDashboardPage />);

    await waitFor(() => expect(screen.getByText('Usage could not be loaded')).toBeTruthy());
    expect(screen.getByText('Could not load usage.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();

    // THE DEFECT: this sentence appeared under the error before the fix.
    expect(screen.queryByText('No usage recorded yet.')).toBeNull();
    // The table chrome must be gone too — a filter bar around a failure is the
    // same lie in smaller type.
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('rollup RESOLVES with []: the genuine empty state SURVIVES (the other polarity)', async () => {
    mockOrgs.mockResolvedValue([ORG_A]);
    mockRollup.mockResolvedValue([]);
    render(<UsageDashboardPage />);

    await waitFor(() => expect(screen.getByText('No usage recorded yet.')).toBeTruthy());
    // Nothing failed, so nothing may claim it did.
    expect(screen.queryByText('Usage could not be loaded')).toBeNull();
  });

  it('Retry actually RE-RUNS the read and recovers — not just a button that renders', async () => {
    mockOrgs.mockResolvedValue([ORG_A]);
    mockRollup.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([row()]);
    render(<UsageDashboardPage />);

    await waitFor(() => expect(screen.getByText('Usage could not be loaded')).toBeTruthy());
    const before = mockRollup.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('claude-opus-5')).toBeTruthy());
    expect(mockRollup.mock.calls.length).toBe(before + 1);
    expect(screen.queryByText('Usage could not be loaded')).toBeNull();
  });
});

describe('UA-R2-2 — a stale org response cannot overwrite a newer one', () => {
  it('A resolving AFTER B does not render A under B', async () => {
    mockOrgs.mockResolvedValue([ORG_A, ORG_B]);

    let resolveA: (v: UsageRollupRow[]) => void = () => {};
    const slowA = new Promise<UsageRollupRow[]>((res) => { resolveA = res; });
    mockRollup.mockImplementation((id: string) =>
      (id === 'org-a' ? slowA : Promise.resolve([row({ model: 'beta-model' })])));

    render(<UsageDashboardPage />);
    // A is selected first (auto-selected) and its read is still in flight.
    await waitFor(() => expect(mockRollup).toHaveBeenCalledWith('org-a'));

    // Switch to B; B resolves immediately.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'org-b' } });
    await waitFor(() => expect(screen.getByText('beta-model')).toBeTruthy());

    // NOW let A land. Without the sequence token this overwrote B's rows.
    await act(async () => { resolveA([row({ model: 'alpha-model' })]); await Promise.resolve(); });

    expect(screen.queryByText('alpha-model')).toBeNull();
    expect(screen.getByText('beta-model')).toBeTruthy();
  });
});
