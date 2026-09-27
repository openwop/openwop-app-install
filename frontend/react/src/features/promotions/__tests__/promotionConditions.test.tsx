/**
 * UX_UPGRADE-promotions — PRO-G1 / PRO-G2.
 *
 *  - PRO-G1: `minSpend` and `budget.maxDiscount` ride in every payload and the
 *    table showed neither — the two numbers that decide WHEN a promotion fires
 *    and HOW MUCH it can cost. Two cart-threshold promotions differing only by
 *    threshold were indistinguishable in the list.
 *  - PRO-G2: a percentage reward got its `%`; a FIXED-amount reward rendered as
 *    a bare number with no unit at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react';
import type { Promotion } from '../promotionsClient.js';

const listPromotions = vi.fn();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../promotionsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listPromotions: () => listPromotions(),
  createPromotion: vi.fn(async () => ({})),
  updatePromotion: vi.fn(async () => ({})),
  deletePromotion: vi.fn(async () => {}),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real hook returns an OBJECT. Mocking it as `true` is what HID the live bug
// (the page did `const enabled = useFeatureAccess(…)` then `if (!enabled)`, which
// is never true for an object, so the toggle-off branch was dead in production
// and this mock made the page agree). Mirror the real shape.
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }) }));

import { PromotionsPage } from '../PromotionsPage.js';

const promo = (over: Partial<Promotion> = {}): Promotion => ({
  promotionId: 'pr-1', orgId: 'org-1', name: 'Spring sale', type: 'cart_threshold',
  reward: { kind: 'percentage', value: 20 }, priority: 10, stackable: false, active: true,
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
} as Promotion);

const view = async (): Promise<void> => {
  render(<PromotionsPage />);
  await act(async () => {});
  await waitFor(() => expect(listPromotions).toHaveBeenCalled());
};

beforeEach(() => {
  listPromotions.mockReset();
  listPromotions.mockResolvedValue({ promotions: [promo()], usage: {} });
});
afterEach(cleanup);

describe('PRO-G1: the list shows when a promotion fires and what it can cost', () => {
  it('shows the cart threshold', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ minSpend: 50 })], usage: {} });
    await view();
    expect(await screen.findByText(/min spend 50/i)).toBeTruthy();
  });

  it('shows the loss budget on a loss-leader', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ type: 'loss_leader', budget: { maxDiscount: 500 } })], usage: {} });
    await view();
    expect(await screen.findByText(/loss budget 500/i)).toBeTruthy();
  });

  it('two promotions differing ONLY by threshold are now distinguishable', async () => {
    listPromotions.mockResolvedValue({ promotions: [
      promo({ promotionId: 'a', name: 'Tier A', minSpend: 50 }),
      promo({ promotionId: 'b', name: 'Tier B', minSpend: 200 }),
    ], usage: {} });
    await view();
    // Previously both rows read identically.
    expect(await screen.findByText(/min spend 50/i)).toBeTruthy();
    expect(screen.getByText(/min spend 200/i)).toBeTruthy();
  });

  it('a promotion with no conditions says so rather than showing a blank cell', async () => {
    await view();
    expect(await screen.findByText(/^none$/i)).toBeTruthy();
  });

  it('shows a segment target when one is set', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ segmentId: 'seg-vip' })], usage: {} });
    await view();
    expect(await screen.findByText(/segment seg-vip/i)).toBeTruthy();
  });
});

describe('PRO-G2: a reward always carries a unit', () => {
  it('a percentage reward reads as a percentage', async () => {
    await view();
    expect(await screen.findByText(/20% off/i)).toBeTruthy();
  });

  it('a FIXED reward is not a bare number', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ reward: { kind: 'fixed', value: 10 } })], usage: {} });
    await view();
    // No currency rides a promotion, so no symbol is invented — but the reward
    // can no longer render as a naked "10".
    const cell = await screen.findByText(/10 off/i);
    expect(cell).toBeTruthy();
    expect(within(cell).queryByText(/^10$/)).toBeNull();
  });
});

describe('R3 P-5 — an exhausted budget must not read Active', () => {
  it('spent >= cap flips the chip to Budget exhausted; under-cap shows burn beside Active', async () => {
    listPromotions.mockResolvedValue({ promotions: [
      promo({ promotionId: 'pr-1', name: 'Loss leader', budget: { maxDiscount: 100 } }),
      promo({ promotionId: 'pr-2', name: 'Half spent', budget: { maxDiscount: 100 } }),
    ], usage: { 'pr-1': { amount: 100, quantity: 4 }, 'pr-2': { amount: 50, quantity: 2 } } });
    await view();
    expect(await screen.findByText('Budget exhausted')).toBeTruthy();
    expect(screen.getByText('50 of 100 spent')).toBeTruthy();
    expect(screen.getAllByText('Budget exhausted').length).toBe(1); // under-cap stays Active
  });

  it('zero usage (absent key) renders plain Active — no fabricated burn', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ budget: { maxDiscount: 100 } })], usage: {} });
    await view();
    expect(await screen.findAllByText('Active')).toBeTruthy();
    expect(screen.queryByText(/of 100 spent/)).toBeNull();
  });
});
