/**
 * ADR 1110 P2 — the Products tab reads the catalog a page at a time: it says how many of
 * how many it shows, "Load more" appends the next page, search runs on the server, and a
 * deep-linked product past the first page is read by id and opened.
 *
 * Sabotage, each restored, each red: dropping the cursor from the Load more read (the
 * append case), filtering the loaded page in the browser instead of passing `q` (the
 * search case), skipping the by-id read (the deep-link case).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(), listProductsPage: vi.fn(), getProductsByIds: vi.fn(), listOrdersPage: vi.fn(),
  listQuotes: vi.fn(), listProductFields: vi.fn(), listPriceLists: vi.fn(),
  listCoupons: vi.fn(), getPaymentsReadiness: vi.fn(), getProductMedia: vi.fn(),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../commerceClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useFeatureAccess: access.useFeatureAccess }));

import { CommercePage } from '../CommercePage.js';
import type { Product } from '../commerceClient.js';

const product = (id: string, name: string): Product => ({ productId: id, type: 'physical', name, price: 1, currency: 'USD', variants: [], active: true, updatedAt: '2026-11-01T00:00:00.000Z' });

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  api.listOrdersPage.mockResolvedValue({ orders: [] });
  api.listQuotes.mockResolvedValue([]);
  api.listProductFields.mockResolvedValue([]);
  api.listPriceLists.mockResolvedValue([]);
  api.listCoupons.mockResolvedValue([]);
  api.getPaymentsReadiness.mockResolvedValue({ settlement: 'platform', connectAvailable: false });
  api.getProductsByIds.mockResolvedValue([]);
  api.getProductMedia.mockResolvedValue([]); // the editor's photo panel
  api.listProductsPage.mockImplementation(async (_org: string, q: { cursor?: string; q?: string }) => {
    if (q.cursor === 'c1') return { products: [product('p3', 'Gamma')] };
    if (q.q) return { products: [product('p9', `Match ${q.q}`)] };
    return { products: [product('p1', 'Alpha'), product('p2', 'Beta')], nextCursor: 'c1', total: 120 };
  });
});
afterEach(cleanup);

describe('ADR 1110 P2 — the Products tab pages the catalog', () => {
  it('says how many of how many, and Load more appends the next page', async () => {
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    expect(await screen.findByText('Showing 2 of 120 products')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Gamma')).toBeTruthy();
    expect(api.listProductsPage).toHaveBeenLastCalledWith('o1', expect.objectContaining({ cursor: 'c1' }));
    expect(screen.getByText('Alpha')).toBeTruthy(); // appended, not replaced
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull(); // no further page
  });

  it('search runs on the server, not over the loaded page', async () => {
    render(<MemoryRouter><CommercePage /></MemoryRouter>);
    await screen.findByText('Alpha');
    // The answer waits, so the in-between state is observable.
    let answer: (v: unknown) => void = () => {};
    const inner = api.listProductsPage.getMockImplementation();
    api.listProductsPage.mockImplementation((org: string, q: { q?: string }) => (q.q ? new Promise((r) => { answer = r; }).then(() => inner?.(org, q)) : inner?.(org, q)));
    const box = screen.getByRole('searchbox');
    box.focus();
    fireEvent.change(box, { target: { value: 'zeta' } });
    await waitFor(() => expect(api.listProductsPage).toHaveBeenCalledWith('o1', expect.objectContaining({ q: 'zeta' })));
    // While the search is in flight the list refreshes IN PLACE: the same box, still focused.
    expect(screen.getByRole('searchbox')).toBe(box);
    expect(document.activeElement).toBe(box);
    answer(undefined);
    expect(await screen.findByText('Match zeta')).toBeTruthy();
    expect(screen.getByRole('searchbox')).toBe(box);
    expect(api.listProductsPage).toHaveBeenCalledWith('o1', expect.objectContaining({ q: 'zeta' }));
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('a deep-linked product past the first page is read by id and opened', async () => {
    api.getProductsByIds.mockResolvedValue([product('p77', 'Deep Item')]);
    render(<MemoryRouter initialEntries={['/?tab=products&product=p77']}><CommercePage /></MemoryRouter>);
    await waitFor(() => expect(api.getProductsByIds).toHaveBeenCalledWith('o1', ['p77']));
    expect(await screen.findByRole('region', { name: /Deep Item/ })).toBeTruthy();
  });
});
