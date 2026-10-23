/**
 * CS-4 (KickTodo UX-ASSESSMENT) — Creator insights: a failed load offers a way
 * back (DESIGN.md §4.6), not a page reload, and the failed read is never shown
 * as "No products yet". Retry re-runs the load and the insights render WITH the
 * re-read rows: the products figure ("1 product") and the row's challenge id.
 *
 * Breaks it (sabotage-witnessed): dropping the Retry button, or a Retry that does
 * not re-run `load` (onClick reduced to a no-op — the products figure never
 * appears); a load that drops the rows it read (`setRows([])` — the products
 * figure assertion goes red).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as SeatClient from '../../../client/kicktodoSeatClient.js';
import type * as KickTodoClient from '../../../client/kicktodoClient.js';
import type { CreatorRevenueRow } from '../../../client/kicktodoSeatClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as commonEn } from '../../../i18n/locales/en/common.js';

const seat = vi.hoisted(() => ({
  getMyRevenue: vi.fn<typeof SeatClient.getMyRevenue>(),
  getMyEarnings: vi.fn<typeof SeatClient.getMyEarnings>(),
  getReferralEarnings: vi.fn<typeof SeatClient.getReferralEarnings>(),
  getSellerOnboardingStatus: vi.fn<typeof SeatClient.getSellerOnboardingStatus>(),
  requestSellerOnboarding: vi.fn<typeof SeatClient.requestSellerOnboarding>(),
}));
vi.mock('../../../client/kicktodoSeatClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoSeatClient.js')>()),
  ...seat,
}));
const kt = vi.hoisted(() => ({ listChallenges: vi.fn<typeof KickTodoClient.listChallenges>() }));
vi.mock('../../../client/kicktodoClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoClient.js')>()),
  ...kt,
}));

import { CreatorInsightsPage } from '../CreatorInsightsPage.js';

const REVENUE = [{
  productId: 'p1', challengeId: 'chal:1', challengeVersion: 1, activeEntitlements: 3, revokedEntitlements: 0,
}] satisfies CreatorRevenueRow[];

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  seat.getMyEarnings.mockResolvedValue({ rows: [], totals: [] });
  seat.getSellerOnboardingStatus.mockResolvedValue({ request: 'none', seller: null });
  seat.getReferralEarnings.mockRejectedValue(new Error('404'));
  kt.listChallenges.mockResolvedValue([]);
});

describe('CreatorInsightsPage — failed load recovery (CS-4)', () => {
  it('a failed revenue read offers Retry, which re-runs the load', async () => {
    seat.getMyRevenue.mockRejectedValueOnce(new Error('revenue failed: 503')).mockResolvedValue(REVENUE);
    render(<MemoryRouter><CreatorInsightsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(en.insightsError)).toBeTruthy());
    expect(screen.queryByRole('region', { name: en.earningsHeading })).toBeNull();
    expect(screen.queryByText(en.insightsEmptyTitle)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: commonEn.retry }));
    await waitFor(() => expect(screen.getByRole('region', { name: en.earningsHeading })).toBeTruthy());
    expect(screen.queryByText(en.insightsError)).toBeNull();
    // The re-read rows render: the products figure and the row (literals, not computed).
    expect(screen.getByText('1 product')).toBeTruthy();
    expect(screen.getByText('chal:1 · v1')).toBeTruthy();
    expect(screen.queryByText(en.insightsEmptyTitle)).toBeNull();
    expect(seat.getMyRevenue).toHaveBeenCalledTimes(2);
  });
});
