/**
 * ADR 0875 (grade-ux COM2UX-3 / COM2UX-6) — the public storefront after the trust fixes.
 *
 *  - a checkout the server refuses for ONE line (a delisted product) names that line
 *    in the shopper's language and lets them remove it — the server's English
 *    `Product not found: prod:…` never reaches the page, and the shopper is not left
 *    retrying into the same refusal;
 *  - the one-click capability `oc` is dropped from the address bar on landing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.name ? `${k}:${String(o.name)}` : k) }) }));
vi.mock('../../../i18n/useFormat.js', () => ({ useFormat: () => ({ date: (d: string) => d, currency: (n: number) => String(n) }) }));

import { StorefrontPage } from '../StorefrontPage.js';

// `PublicProduct` is module-private to StorefrontPage, so these mirror its shape by hand.
const PRODUCT = { productId: 'prod:a', type: 'digital', name: 'Guide', price: 20, currency: 'USD', imageAssetTokens: [], variants: [], categories: [], tags: [] };
// A SECOND line that stays listed. With a one-line cart, Remove empties the cart and
// unmounts the whole checkout form, so "the refusal clears" passed whether or not the
// handler cleared it (round-1 probe sf-remove-clears was vacuous for exactly that).
const KEPT = { ...PRODUCT, productId: 'prod:b', name: 'Pen', price: 5 };

function mockFetch(checkout: { status: number; body: unknown }): ReturnType<typeof vi.fn> {
  let checkedOut = false;
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes('/checkout')) { checkedOut = true; return new Response(JSON.stringify(checkout.body), { status: checkout.status, headers: { 'content-type': 'application/json' } }); }
    // After the refusal the product is no longer listed (it was delisted mid-cart).
    return new Response(JSON.stringify({ products: checkedOut ? [KEPT] : [PRODUCT, KEPT], store: { name: 'Shop' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => { window.history.replaceState(null, '', '/store/org-1'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ADR 0875 — storefront refusals are actionable', () => {
  it('a refused line is named and removable; the raw server message is not shown', async () => {
    mockFetch({ status: 400, body: { error: 'validation_error', message: 'Product not found: prod:a', details: { productId: 'prod:<redacted:high-entropy>' } } }); // the wire scrubs ids
    render(<StorefrontPage orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'addOne:Guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'addOne:Pen' }));
    fireEvent.click(screen.getByRole('button', { name: 'checkout' }));
    fireEvent.change(screen.getByLabelText(/fieldEmail/), { target: { value: 'a@b.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'placeOrder' }));

    expect(await screen.findByText('lineUnavailable:Guide')).toBeTruthy();
    // The generic fallback is what a failed line-identification would show instead.
    // (The server's `Product not found` English has no render path at all, so
    // asserting its absence could never fail.)
    expect(screen.queryByText('checkoutFailed')).toBeNull();
    // The chip marks the refused line, and only that one.
    expect(screen.getAllByText('lineUnavailableChip')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'removeLine:Guide' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'removeLine:Guide' })).toBeNull());
    // The checkout is still open on the remaining line, and the refusal is gone.
    expect(screen.getByRole('button', { name: 'removeLine:Pen' })).toBeTruthy();
    expect(screen.queryByText('lineUnavailable:Guide')).toBeNull();
    expect(screen.queryByText('lineUnavailableChip')).toBeNull();
  });

  it('drops the one-click capability from the address bar', async () => {
    window.history.replaceState(null, '', '/store/org-1?order=ord%3Aabc&paid=1&oc=secret-token');
    mockFetch({ status: 201, body: {} });
    render(<StorefrontPage orgId="org-1" />);
    await waitFor(() => expect(window.location.search).not.toMatch(/oc=/));
    // Exact: only `oc` is dropped; the order id and the paid flag survive.
    expect(window.location.search).toBe('?order=ord%3Aabc&paid=1');
  });
});
