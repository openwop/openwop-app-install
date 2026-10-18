/**
 * UX_UPGRADE-commerce-ucp-buyer — UCP-G1 / UCP-G2.
 *
 *  - UCP-G1: the authorized ceiling and the cart total sat in two separate cards
 *    and were never related, leaving the reader to do minor-unit arithmetic to
 *    answer the page's central question — how much of what I authorized did the
 *    agent actually spend? (The ceiling IS enforced server-side, so this is
 *    legibility, not a new guarantee.)
 *  - UCP-G2: payment-mandate warnings arrived as raw `code: prose` strings. On a
 *    payment-authorization surface, in a four-locale app, "this is not a
 *    verifiable credential" deserves prose rather than a snake_case dump.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Ap2PaymentMandate, UcpPurchase } from '../ucpBuyerClient.js';

const getPurchase = vi.fn();

vi.mock('../ucpBuyerClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPurchase: (...a: unknown[]) => getPurchase(...a),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { PurchaseDetailPage } from '../PurchaseDetailPage.js';

// A COMPLETE fixture, no cast: the old `as UcpPurchase` hid a field the type does
// not have (`orgId`) and two it requires (`createdBy`, `updatedAt`).
const purchase = (over: Partial<UcpPurchase> = {}): UcpPurchase => ({
  purchaseId: 'pur-1', status: 'placed', createdBy: 'user-1',
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  merchantUrl: 'https://shop.example',
  intentMandate: { kind: 'ap2.intent', intent: 'Buy printer paper', maxAmountMinor: 20000, currency: 'USD', createdAt: '2026-07-01T00:00:00.000Z' },
  cartMandate: {
    kind: 'ap2.cart', merchantUrl: 'https://shop.example', currency: 'USD', totalMinor: 15000,
    lines: [{ externalProductId: 'p1', name: 'Paper', quantity: 3, unitPriceMinor: 5000 }],
    createdAt: '2026-07-01T00:00:00.000Z',
  },
  ...over,
});
const mandate = (warnings: string[]): Ap2PaymentMandate => ({
  kind: 'ap2.payment', approvalId: 'apr-1', totalMinor: 15000, currency: 'USD', warnings, createdAt: '2026-07-01T00:00:00.000Z',
});

const view = async (): Promise<void> => {
  render(
    <MemoryRouter initialEntries={['/commerce/purchases/pur-1?org=org-1']}>
      <Routes><Route path="/commerce/purchases/:purchaseId" element={<PurchaseDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await waitFor(() => expect(screen.getByText('Buy printer paper')).toBeTruthy());
};

beforeEach(() => {
  getPurchase.mockReset();
  getPurchase.mockResolvedValue(purchase());
});
afterEach(cleanup);

describe('UCP-G1: the page relates the spend to the authorization', () => {
  it('states how much of the ceiling the agent used', async () => {
    await view();
    // $150.00 of $200.00 authorized (75%) — previously two numbers in two cards.
    expect(await screen.findByText(/\$150\.00 of \$200\.00 authorized \(75%\)/)).toBeTruthy();
  });

  it('handles a purchase that used the whole authorization', async () => {
    getPurchase.mockResolvedValue(purchase({
      cartMandate: { ...purchase().cartMandate, totalMinor: 20000 },
    }));
    await view();
    expect(await screen.findByText('$200.00 of $200.00 authorized (100%)')).toBeTruthy();
  });
});

describe('UCP-G2: mandate warnings read as prose', () => {
  it('renders localized prose for a known code, keeping the detail', async () => {
    getPurchase.mockResolvedValue(purchase({ paymentMandate: mandate(['ap2_vc_signing_not_configured: demo-mode mandate — not a verifiable credential']) }));
    await view();
    expect(await screen.findByText(
      // The prose and its secondary detail share one span, so match the full sentence as a substring.
      'This mandate is not a verifiable credential — signing is not configured, so it carries no cryptographic proof.',
      { exact: false },
    )).toBeTruthy();
    // The raw detail is kept as secondary text rather than discarded.
    expect(screen.getByText(/demo-mode mandate/)).toBeTruthy();
  });

  it('an UNKNOWN code still shows its raw string — never swallowed', async () => {
    getPurchase.mockResolvedValue(purchase({ paymentMandate: mandate(['ap2_future_rule: something new happened']) }));
    await view();
    expect(await screen.findByText(/ap2_future_rule: something new happened/)).toBeTruthy();
  });

  it('a warning with no code prefix is shown verbatim', async () => {
    getPurchase.mockResolvedValue(purchase({ paymentMandate: mandate(['just some prose with no code']) }));
    await view();
    expect(await screen.findByText('just some prose with no code')).toBeTruthy();
  });

  it('no warnings shows the integrity-only chip, never a bare "Signed"', async () => {
    getPurchase.mockResolvedValue(purchase({ paymentMandate: mandate([]) }));
    await view();
    // R2 UCP-P2-I1 — the chip claims integrity only. `/signed/i` also matched the
    // bare "Signed" chip that overclaimed authenticity, so it could not fail.
    expect(await screen.findByText('Signed (integrity only — the issuer is not verified)')).toBeTruthy();
    expect(screen.queryByText('Signed')).toBeNull();
  });
});
