/**
 * UX_UPGRADE-promotions — PRO-G1 / PRO-G2.
 *
 *  - PRO-G1: `minSpend` and `budget.maxDiscount` ride in every payload and the
 *    table showed neither — the two numbers that decide WHEN a promotion fires
 *    and HOW MUCH it can cost. Two cart-threshold promotions differing only by
 *    threshold were indistinguishable in the list.
 *  - PRO-G2: a percentage reward got its `%`; a FIXED-amount reward rendered as
 *    a bare number with no unit at all.
 *  - PROMO-CUR-1 (fixed in #4882): every amount carries the promotion's recorded
 *    currency.
 *
 * Fixtures are what the server sends since ADR 1025 D4: a promotion that carries
 * an amount (min spend, fixed reward, loss budget) and no currency is listed in
 * `needsCurrency`, and the budget/burn cases record a currency, because a
 * currency-less budgeted row reads "needs a currency", never Active or
 * exhausted. Each case settles on the row's NAME (rendered whatever the other
 * cells say), then reads the asserted cell as an exact VALUE, so a sabotage
 * reds on the value rather than on a lookup that times out (waves 111, 115).
 *
 * Sabotages that turn it red: dropping the `condMinSpend`, `condBudget` or
 * `condSegment` push, the `condNone` copy, the percent or fixed reward label,
 * `>=` → `>` on the exhausted boundary, an exhausted test that also trips under
 * the cap, a burn fabricated for absent usage, the burn hidden, and `money()`
 * ignoring `p.currency`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type { Promotion } from '../promotionsClient.js';

const listPromotions = vi.fn<typeof import('../promotionsClient.js')['listPromotions']>();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../promotionsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listPromotions: (orgId: string) => listPromotions(orgId),
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
});

const view = async (): Promise<void> => {
  render(<PromotionsPage />);
  await act(async () => {});
  await waitFor(() => expect(listPromotions).toHaveBeenCalled());
};

beforeEach(() => {
  listPromotions.mockReset();
  listPromotions.mockResolvedValue({ promotions: [promo()], usage: {}, needsCurrency: [] });
});
afterEach(cleanup);

describe('PRO-G1: the list shows when a promotion fires and what it can cost', () => {
  it('shows the cart threshold', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ minSpend: 50 })], usage: {}, needsCurrency: ['pr-1'] });
    await view();
    await screen.findByText('Spring sale');
    expect(screen.queryAllByText('Min spend 50')).toHaveLength(1);
  });

  it('shows the loss budget on a loss-leader', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ type: 'loss_leader', budget: { maxDiscount: 500 } })], usage: {}, needsCurrency: ['pr-1'] });
    await view();
    await screen.findByText('Spring sale');
    expect(screen.queryAllByText('Loss budget 500')).toHaveLength(1);
  });

  it('two promotions differing ONLY by threshold are now distinguishable', async () => {
    listPromotions.mockResolvedValue({ promotions: [
      promo({ promotionId: 'a', name: 'Tier A', minSpend: 50 }),
      promo({ promotionId: 'b', name: 'Tier B', minSpend: 200 }),
    ], usage: {}, needsCurrency: ['a', 'b'] });
    await view();
    await screen.findByText('Tier B');
    // Previously both rows read identically.
    expect(screen.queryAllByText('Min spend 50')).toHaveLength(1);
    expect(screen.queryAllByText('Min spend 200')).toHaveLength(1);
  });

  it('a promotion with no conditions says so rather than showing a blank cell', async () => {
    await view();
    await screen.findByText('Spring sale');
    expect(screen.queryAllByText('None')).toHaveLength(1);
  });

  it('shows a segment target when one is set', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ segmentId: 'seg-vip' })], usage: {}, needsCurrency: [] });
    await view();
    await screen.findByText('Spring sale');
    expect(screen.queryAllByText('Segment seg-vip')).toHaveLength(1);
  });
});

describe('PRO-G2: a reward always carries a unit', () => {
  it('a percentage reward reads as a percentage', async () => {
    await view();
    await screen.findByText('Spring sale');
    expect(screen.queryAllByText('20% off')).toHaveLength(1);
  });

  it('a FIXED reward is not a bare number', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ reward: { kind: 'fixed', value: 10 } })], usage: {}, needsCurrency: ['pr-1'] });
    await view();
    await screen.findByText('Spring sale');
    // This promotion records no currency (pre-PRO2-P1), so no symbol is
    // invented — but the reward cell reads "10 off", never a naked number. (The
    // priority cell is also "10", which is why the claim is the exact label.)
    expect(screen.queryAllByText('10 off')).toHaveLength(1);
  });
});

describe('R3 P-5 — an exhausted budget must not read Active', () => {
  it('spent >= cap flips the chip to Budget exhausted; under-cap shows burn beside Active', async () => {
    listPromotions.mockResolvedValue({ promotions: [
      promo({ promotionId: 'pr-1', name: 'Loss leader', currency: 'EUR', budget: { maxDiscount: 100 } }),
      promo({ promotionId: 'pr-2', name: 'Half spent', currency: 'EUR', budget: { maxDiscount: 100 } }),
    ], usage: { 'pr-1': { amount: 100, quantity: 4 }, 'pr-2': { amount: 50, quantity: 2 } }, needsCurrency: [] });
    await view();
    await screen.findByText('Half spent');
    // Exactly one exhausted (pr-1 sits ON the cap); the under-cap row stays Active.
    expect(screen.queryAllByText('Budget exhausted')).toHaveLength(1);
    expect(screen.queryAllByText('Active')).toHaveLength(1);
    expect(screen.queryAllByText('€50.00 of €100.00 spent')).toHaveLength(1);
  });

  it('zero usage (absent key) renders plain Active — no fabricated burn', async () => {
    listPromotions.mockResolvedValue({ promotions: [promo({ currency: 'EUR', budget: { maxDiscount: 100 } })], usage: {}, needsCurrency: [] });
    await view();
    await screen.findByText('Spring sale');
    expect(screen.queryAllByText('Active')).toHaveLength(1);
    expect(screen.queryAllByText(/ spent$/)).toHaveLength(0);
  });

  // PROMO-CUR-1 — since R2 PRO2-P1 a promotion RECORDS its currency, and the
  // list still dropped it: a EUR reward read "10 off". Every money amount in the
  // row (reward, threshold, loss budget, burn) now carries it. Expected strings
  // written by hand for the `en` test locale. Sabotage: make `money()` ignore
  // `p.currency` → red.
  it('a promotion with a recorded currency shows it on every amount (PROMO-CUR-1)', async () => {
    listPromotions.mockResolvedValue({
      promotions: [promo({ type: 'loss_leader', currency: 'EUR', reward: { kind: 'fixed', value: 10 }, minSpend: 50, budget: { maxDiscount: 200 } })],
      usage: { 'pr-1': { amount: 75, quantity: 3 } }, needsCurrency: [],
    });
    await view();
    await screen.findByText('Spring sale');
    expect(screen.queryAllByText('€10.00 off')).toHaveLength(1);
    expect(screen.queryAllByText('Min spend €50.00')).toHaveLength(1);
    expect(screen.queryAllByText('Loss budget €200.00')).toHaveLength(1);
    expect(screen.queryAllByText('€75.00 of €200.00 spent')).toHaveLength(1);
  });
});
