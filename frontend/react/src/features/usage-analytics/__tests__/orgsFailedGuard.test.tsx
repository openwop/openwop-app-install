/**
 * Usage analytics — a failed workspace read must not be rendered as "no usage".
 *
 * The rollup read is gated on the org selection, so a failed workspace read
 * means the rollup was never requested: the page's own `rows === null && !error`
 * branch stays true forever and renders a permanent skeleton. `UsageDashboardPage`
 * consumes `ui/useOrgSelection`'s `orgsFailed` correctly, but nothing failed when
 * the seam itself was sabotaged (`setOrgsFailed(true)` → `setOrgs([])`) and the
 * suite stayed green. This file is the guard that measurement said was missing.
 *
 * It renders the REAL `UsageDashboardPage` and forces the failure through the
 * REAL client function the page calls (`client/usageAnalyticsClient.listOrgs`) —
 * never the hook, never a replica.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a broken
 * render would satisfy it:
 *   - read FAILS  → the announced, retryable failure card; NEVER "No usage
 *     recorded yet." and never the silent skeleton it replaced
 *   - read SUCCEEDS → the genuine empty state survives
 *
 * HG-1 CORRECTION. The empty-workspace arm used to assert the LOADING SKELETON
 * and called it "what is actually true". It was not: with `orgs === []` the
 * rollup is never requested, so `rows === null && !error` stayed true forever and
 * the page rendered a permanent skeleton — a `role="status"` "Loading…" live
 * region announcing work that will never finish. The server answered "none"; the
 * screen said "loading". That arm now pins the zero-workspace StateCard, and this
 * test is the reason the page can no longer regress to the skeleton.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));
vi.mock('../../../client/usageAnalyticsClient.js', () => ({ listOrgs: vi.fn(), fetchUsageRollup: vi.fn() }));

import { listOrgs, fetchUsageRollup } from '../../../client/usageAnalyticsClient.js';
import { UsageDashboardPage } from '../UsageDashboardPage.js';

const mockOrgs = vi.mocked(listOrgs);
const mockRollup = vi.mocked(fetchUsageRollup);

beforeEach(() => { mockOrgs.mockReset(); mockRollup.mockReset(); mockRollup.mockResolvedValue([]); });
afterEach(cleanup);

describe('usage analytics — failed workspace read is not "no usage"', () => {
  it('read FAILS: the honest, retryable card — and NEVER "No usage recorded yet."', async () => {
    mockOrgs.mockRejectedValue(new Error('boom'));
    render(<UsageDashboardPage />);
    await waitFor(() => expect(screen.getByText('Could not load your organizations')).toBeTruthy());
    expect(screen.getByText(
      'The usage rollup was never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The false claim must be absent — and so must the silent skeleton, which is
    // what a failed org read rendered before `orgsFailed` was consumed here.
    expect(screen.queryByText('No usage recorded yet.')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(mockRollup).not.toHaveBeenCalled();
  });

  it('read SUCCEEDS with []: the zero-ORGANIZATION state — not a failure, not an endless skeleton', async () => {
    mockOrgs.mockResolvedValue([]);
    render(<UsageDashboardPage />);
    await waitFor(() => expect(screen.getByText('No organizations')).toBeTruthy());
    expect(screen.getByText('Model usage belongs to an organization.')).toBeTruthy();
    // Nothing failed, so nothing may claim it did.
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    // And the defect this replaces: the rollup is never requested with no org,
    // so the loading branch had no terminal condition and its live region told a
    // screen-reader user, permanently, that work was in progress.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(mockRollup).not.toHaveBeenCalled();
  });

  it('healthy read with no usage: the genuine "No usage recorded yet." still shows', async () => {
    mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    render(<UsageDashboardPage />);
    await waitFor(() => expect(screen.getByText('No usage recorded yet.')).toBeTruthy());
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });
});
