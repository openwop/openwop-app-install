/**
 * ADR 0336 (deep-link program) / DL-T-1b — PurchaseDetailPage derives its
 * target from `:purchaseId` (path) + `?org=` (search). Same deep-link contract
 * as OrderDetailPage: fetch keyed on the derived pair, missing `?org=` fails
 * closed to not-found WITHOUT a fetch, a 404 renders not-found, and the
 * commerce-ucp-buyer access-gate holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { getPurchase, UcpBuyerApiError } = vi.hoisted(() => {
  class UcpBuyerApiError extends Error {
    status: number;
    constructor(status: number) { super(`http ${status}`); this.status = status; }
  }
  return { getPurchase: vi.fn(), UcpBuyerApiError };
});
vi.mock('../ucpBuyerClient.js', () => ({
  getPurchase,
  merchantLabel: (p: { merchantLabel?: string }) => p.merchantLabel ?? 'merchant',
  UcpBuyerApiError,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../i18n/useFormat.js', () => ({ useFormat: () => ({ date: (d: string) => d, currencyMinor: (n: number) => String(n) }) }));
vi.mock('../PurchasesPage.js', () => ({ PurchaseStatusChip: ({ status }: { status: string }) => <span>{status}</span> }));
const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => access.value }));

import { PurchaseDetailPage } from '../PurchaseDetailPage.js';

const aPurchase = {
  purchaseId: 'pur_1', merchantLabel: 'Acme', status: 'placed', createdAt: '2026-07-10',
  intentMandate: { intent: 'buy widgets', maxAmountMinor: 5000, currency: 'USD' },
  cartMandate: { currency: 'USD', totalMinor: 2000, lines: [{ externalProductId: 'x1', name: 'Widget', quantity: 2, unitPriceMinor: 1000 }] },
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/commerce/purchases/:purchaseId" element={<PurchaseDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  getPurchase.mockReset();
  access.value = { enabled: true, loading: false, variant: undefined };
});

describe('PurchaseDetailPage deep-link derivation (DL-T-1b)', () => {
  it('fetches the purchase keyed on the derived (orgId, purchaseId) and renders it', async () => {
    getPurchase.mockResolvedValue(aPurchase);
    renderAt('/commerce/purchases/pur_1?org=ws_7');
    await waitFor(() => expect(getPurchase).toHaveBeenCalledWith('ws_7', 'pur_1'));
    expect(await screen.findByText('Acme')).toBeTruthy();
  });

  it('fails closed to not-found (no fetch) when ?org= is absent', async () => {
    renderAt('/commerce/purchases/pur_1');
    expect(await screen.findByText('notFoundTitle')).toBeTruthy();
    expect(getPurchase).not.toHaveBeenCalled();
  });

  it('renders not-found on a 404 (tenant-scoped miss)', async () => {
    getPurchase.mockRejectedValue(new UcpBuyerApiError(404));
    renderAt('/commerce/purchases/ghost?org=ws_7');
    expect(await screen.findByText('notFoundTitle')).toBeTruthy();
  });

  it('shows the not-enabled gate when the feature is off', async () => {
    access.value = { enabled: false, loading: false, variant: undefined };
    renderAt('/commerce/purchases/pur_1?org=ws_7');
    expect(await screen.findByText('notEnabledTitle')).toBeTruthy();
    expect(getPurchase).not.toHaveBeenCalled();
  });
});
