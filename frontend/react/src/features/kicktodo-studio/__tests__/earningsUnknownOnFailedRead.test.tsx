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
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const seat = vi.hoisted(() => ({
  getMyRevenue: vi.fn(),
  getMyEarnings: vi.fn(),
  getReferralEarnings: vi.fn(),
  getSellerOnboardingStatus: vi.fn(),
  requestSellerOnboarding: vi.fn(),
  earningsCsvUrl: vi.fn(() => '/csv'),
}));
vi.mock('../../../client/kicktodoSeatClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoSeatClient.js')>()),
  ...seat,
}));
const kt = vi.hoisted(() => ({ listChallenges: vi.fn() }));
vi.mock('../../../client/kicktodoClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoClient.js')>()),
  ...kt,
}));

import { CreatorInsightsPage } from '../CreatorInsightsPage.js';

const REVENUE = [{
  productId: 'p1', title: 'Course', activeEntitlements: 3, revokedEntitlements: 0,
}];

const mount = async (): Promise<void> => {
  render(<MemoryRouter><CreatorInsightsPage /></MemoryRouter>);
  await act(async () => {});
};

const NOTHING_YET = /Nothing accrued yet/i;
const UNKNOWN = /could.{0,3}n.{0,3}t be read|is unknown/i;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // Revenue must SUCCEED — the earnings section only renders when `rows` loaded,
  // so a failed revenue read would make these assertions unreachable rather than
  // false. (An incomplete fixture is how this kind of test goes silently vacuous.)
  seat.getMyRevenue.mockResolvedValue(REVENUE);
  seat.getSellerOnboardingStatus.mockResolvedValue({ request: 'none', seller: null });
  seat.getReferralEarnings.mockResolvedValue(null);
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
  });

  it('earnings read SUCCEEDS with no totals: "Nothing accrued yet" is TRUE and stays', async () => {
    seat.getMyEarnings.mockResolvedValue({ totals: [] });
    await mount();

    expect(screen.getByText(NOTHING_YET)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
  });

  it('the failed read does not blank the section — onboarding stays reachable', async () => {
    // The reason this is a ternary and not a gate. If the fix had merely
    // suppressed the line, this section would render with no explanation beside
    // the onboarding controls.
    seat.getMyEarnings.mockRejectedValue(new Error('503'));
    await mount();

    const section = screen.getByLabelText(/earnings/i);
    expect(section.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(section.textContent).toMatch(UNKNOWN);
  });
});
