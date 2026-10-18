/**
 * CI-R2-1 — a failed earnings read must not tell a creator they earned nothing.
 *
 * `getMyEarnings().catch(() => null)` sets `earningsFailed` AND
 * `setEarningTotals(earnings?.totals ?? [])` → `[]`. The earnings section then
 * rendered "Nothing accrued yet — earnings appear here with your first sale."
 * on a read that never arrived. On a money surface a confident zero is the
 * costliest possible wrong answer: it is indistinguishable from "you have made
 * no sales", and it is the sentence a creator would act on.
 *
 * Found by the 2026-08-10 audit of the render-time `?? []` failed-read class —
 * the shape `scripts/check-failed-read-sentinels.mjs` cannot see, because the
 * empty is minted at render, not written by the catch. 2 of 61 candidate files
 * were real; this was one.
 *
 * WHY A TERNARY AND NOT A BARE `!earningsFailed` GATE. The section must stay
 * visible — payout ONBOARDING lives inside it and must be reachable before a
 * first sale — so suppressing the line would leave a BLANK beside the onboarding
 * chips, which reads as "loaded, nothing here": the same false impression with
 * no words to argue with. The failure gets its own sentence.
 *
 * Both polarities, because an absence-only assertion is vacuous.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as SeatClient from '../../../client/kicktodoSeatClient.js';
import type * as KickTodoClient from '../../../client/kicktodoClient.js';
import type { CreatorRevenueRow } from '../../../client/kicktodoSeatClient.js';

// Typed to the real client signatures, so a fixture that drifts from the
// production shape is a compile error, not a silently-passing render.
// (`earningsCsvUrl` is a string const in the client, kept from the original.)
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

const mount = async (): Promise<void> => {
  render(<MemoryRouter><CreatorInsightsPage /></MemoryRouter>);
  await act(async () => {});
};

const NOTHING_YET = /Nothing accrued yet/i;
const UNKNOWN = /could.{0,3}n.{0,3}t be read|is unknown/i;
// The page-level failure notice (earningsLoadError) — distinct from UNKNOWN.
const LOAD_ERROR = /couldn.t load right now/i;
const ONBOARDING = { name: 'Request payout onboarding' } as const;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // Revenue must SUCCEED — the earnings section only renders when `rows` loaded,
  // so a failed revenue read would make these assertions unreachable rather than
  // false. (An incomplete fixture is how this kind of test goes silently vacuous.)
  seat.getMyRevenue.mockResolvedValue(REVENUE);
  seat.getSellerOnboardingStatus.mockResolvedValue({ request: 'none', seller: null });
  // No referral code: the client THROWS on a non-OK read and the page catches
  // it to null — the production path (the client never resolves null).
  seat.getReferralEarnings.mockRejectedValue(new Error('404'));
  kt.listChallenges.mockResolvedValue([]);
});

describe('CI-R2-1 — a failed earnings read is unknown, not zero', () => {
  it('earnings read FAILS: says unknown, and NEVER "Nothing accrued yet"', async () => {
    seat.getMyEarnings.mockRejectedValue(new Error('503'));
    await mount();

    // The section is still here (payout onboarding must stay reachable)…
    expect(screen.getByText(UNKNOWN)).toBeTruthy();
    // …and the false claim is gone.
    expect(screen.queryByText(NOTHING_YET)).toBeNull();
    // The page-level failure notice is stated too.
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy();
  });

  it('earnings read SUCCEEDS with no totals: "Nothing accrued yet" is TRUE and stays', async () => {
    seat.getMyEarnings.mockResolvedValue({ rows: [], totals: [] });
    await mount();

    expect(screen.getByText(NOTHING_YET)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
  });

  it('the failed read does not blank the section — onboarding stays reachable', async () => {
    // The reason this is a ternary and not a gate. If the fix had merely
    // suppressed the line, this section would render with no explanation beside
    // the onboarding controls.
    seat.getMyEarnings.mockRejectedValue(new Error('503'));
    await mount();

    const section = screen.getByLabelText(/earnings/i);
    expect(section.textContent).toMatch(UNKNOWN);
    // The onboarding control itself is still inside the section.
    expect(within(section).getByRole('button', ONBOARDING)).toBeTruthy();
  });
});
