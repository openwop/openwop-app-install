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

const getPurchase = vi.hoisted(() => vi.fn());
// Spread the REAL module: the product's `instanceof UcpBuyerApiError` and
// `merchantLabel` are the shipped ones. The old stub echoed a `merchantLabel` field
// that `UcpPurchase` does not have, so "renders it" proved only the stub, and its
// error class took `(status)` where the real one takes `(message, code, status)`.
vi.mock('../ucpBuyerClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPurchase,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../i18n/useFormat.js', () => ({ useFormat: () => ({ date: (d: string) => d, currencyMinor: (n: number) => String(n) }) }));
vi.mock('../PurchasesPage.js', () => ({ PurchaseStatusChip: ({ status }: { status: string }) => <span>{status}</span> }));
const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => access.value }));

import { PurchaseDetailPage } from '../PurchaseDetailPage.js';
import { UcpBuyerApiError, type UcpPurchase } from '../ucpBuyerClient.js';

const aPurchase: UcpPurchase = {
  purchaseId: 'pur_1', merchantUrl: 'https://acme.example', status: 'placed',
  createdBy: 'user-1', createdAt: '2026-07-10', updatedAt: '2026-07-10',
  intentMandate: { kind: 'ap2.intent', intent: 'buy widgets', maxAmountMinor: 5000, currency: 'USD', createdAt: '2026-07-10' },
  cartMandate: {
    kind: 'ap2.cart', merchantUrl: 'https://acme.example', currency: 'USD', totalMinor: 2000, createdAt: '2026-07-10',
    lines: [{ externalProductId: 'x1', name: 'Widget', quantity: 2, unitPriceMinor: 1000 }],
  },
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
    expect(await screen.findByText('https://acme.example')).toBeTruthy();
    expect(screen.getByText('buy widgets')).toBeTruthy();
  });

  it('fails closed to not-found (no fetch) when ?org= is absent', async () => {
    renderAt('/commerce/purchases/pur_1');
    expect(await screen.findByText('notFoundTitle')).toBeTruthy();
    expect(getPurchase).not.toHaveBeenCalled();
  });

  it('renders not-found on a 404 (tenant-scoped miss)', async () => {
    getPurchase.mockRejectedValue(new UcpBuyerApiError('Not found', 'not_found', 404));
    renderAt('/commerce/purchases/ghost?org=ws_7');
    expect(await screen.findByText('notFoundTitle')).toBeTruthy();
    expect(getPurchase).toHaveBeenCalledWith('ws_7', 'ghost');
    expect(screen.queryByText('loadErrorTitle')).toBeNull();
  });

  it('shows the not-enabled gate when the feature is off', async () => {
    access.value = { enabled: false, loading: false, variant: undefined };
    renderAt('/commerce/purchases/pur_1?org=ws_7');
    expect(await screen.findByText('notEnabledTitle')).toBeTruthy();
    expect(getPurchase).not.toHaveBeenCalled();
  });
});
