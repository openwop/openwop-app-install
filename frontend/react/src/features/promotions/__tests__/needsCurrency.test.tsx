/**
 * ADR 1025 D4 — a promotion that carries an amount but no currency applies to NO order
 * (the server's `needsCurrency`). Before this, the console read it "Active" while the
 * engine applied it in any currency (¥10 off a ¥3,000 order, probed). Now the status
 * says it is not applying, and the row offers the one-click fix: pick a currency, Set.
 *
 * Sabotages that turn it red: the chip branch removed (the row reads "Active" again);
 * the Set button sending no `currency`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { Promotion } from '../promotionsClient.js';

const listPromotions = vi.fn<typeof import('../promotionsClient.js')['listPromotions']>();
const updatePromotion = vi.fn<typeof import('../promotionsClient.js')['updatePromotion']>();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../promotionsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listPromotions: (orgId: string) => listPromotions(orgId),
  createPromotion: vi.fn(async () => ({})),
  updatePromotion: (orgId: string, id: string, patch: { active?: boolean; currency?: string }) => updatePromotion(orgId, id, patch),
  deletePromotion: vi.fn(async () => {}),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }) }));

import { PromotionsPage } from '../PromotionsPage.js';

const legacy: Promotion = {
  promotionId: 'pr-legacy', orgId: 'org-1', name: '$10 off orders over $60', type: 'cart_threshold',
  reward: { kind: 'fixed', value: 10 }, minSpend: 60, priority: 1, stackable: true, active: true,
  createdAt: '2026-07-09T00:00:00.000Z', updatedAt: '2026-07-09T00:00:00.000Z',
};

beforeEach(() => {
  listPromotions.mockReset();
  updatePromotion.mockReset();
  updatePromotion.mockResolvedValue({ ...legacy, currency: 'EUR' });
});
afterEach(cleanup);

describe('ADR 1025 D4 — a currency-less denominated promotion reads as not applying, with the fix', () => {
  it('shows "Not applying: needs a currency" instead of Active, and Set currency PATCHes the picked one', async () => {
    listPromotions.mockResolvedValue({ promotions: [legacy], usage: {}, needsCurrency: ['pr-legacy'] });
    render(<PromotionsPage />);
    await act(async () => {});
    expect(await screen.findByText('Not applying: needs a currency')).toBeTruthy();
    expect(screen.queryByText('Active')).toBeNull();
    // Nothing is pre-picked (a default would relabel the promotion), so Set waits for a choice.
    const set = screen.getByRole('button', { name: 'Set currency for $10 off orders over $60' }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    // …and Activate is held until there is a currency (the server refuses it).
    fireEvent.change(screen.getByLabelText('Currency for $10 off orders over $60'), { target: { value: 'EUR' } });
    expect(set.disabled).toBe(false);
    fireEvent.click(set);
    await waitFor(() => expect(updatePromotion).toHaveBeenCalledWith('org-1', 'pr-legacy', { currency: 'EUR' }));
  });

  it('a promotion with its currency shows Active and no fix control (control)', async () => {
    listPromotions.mockResolvedValue({ promotions: [{ ...legacy, currency: 'USD' }], usage: {}, needsCurrency: [] });
    render(<PromotionsPage />);
    await act(async () => {});
    expect(await screen.findByText('Active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Set currency/ })).toBeNull();
  });

  it('a PAUSED currency-less row still says why, and its Activate is disabled', async () => {
    listPromotions.mockResolvedValue({ promotions: [{ ...legacy, active: false }], usage: {}, needsCurrency: ['pr-legacy'] });
    render(<PromotionsPage />);
    await act(async () => {});
    expect(await screen.findByText('Not applying: needs a currency')).toBeTruthy();
    const activate = screen.getByRole('button', { name: 'Activate $10 off orders over $60' }) as HTMLButtonElement;
    expect(activate.disabled).toBe(true);
    // The disabled control points at its reason (MCHUX-16).
    expect(document.getElementById(activate.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Not applying: needs a currency');
  });

  it('a currency-less agent draft shows BOTH reasons (MCHUX-15)', async () => {
    listPromotions.mockResolvedValue({ promotions: [{ ...legacy, active: false, proposed: true }], usage: {}, needsCurrency: ['pr-legacy'] });
    render(<PromotionsPage />);
    await act(async () => {});
    expect(await screen.findByText('Not applying: needs a currency')).toBeTruthy();
    expect(screen.getByText('Proposed by an agent')).toBeTruthy();
  });

  it('an agent draft reads "Proposed by an agent", not Paused', async () => {
    listPromotions.mockResolvedValue({ promotions: [{ ...legacy, currency: 'USD', active: false, proposed: true }], usage: {}, needsCurrency: [] });
    render(<PromotionsPage />);
    await act(async () => {});
    expect(await screen.findByText('Proposed by an agent')).toBeTruthy();
    expect(screen.queryByText('Paused')).toBeNull();
  });
});
