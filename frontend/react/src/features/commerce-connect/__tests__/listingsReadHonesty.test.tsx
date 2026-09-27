/**
 * CCX-R2-1 (commerce-connect round 2) — a failed listings read must not tell
 * a SELLER "no listings yet" about their own marketplace inventory.
 *
 * `listOwnListings().catch(() => setRows([]))` rendered `noListingsYet` on
 * any failure — the failure-as-EMPTY shape on a money surface. Both
 * polarities + retry recovery pinned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({ listOwnListings: vi.fn() }));
vi.mock('../commerceConnectClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, listOwnListings: api.listOwnListings };
});

import { SellerListingsCard } from '../SellerListingsCard.js';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('CCX-R2-1 — seller listings honesty', () => {
  it('FAILED read: says listings could not be loaded (with retry), never "no listings yet"', async () => {
    api.listOwnListings.mockRejectedValue(new Error('listings_500'));
    render(<SellerListingsCard />);
    expect(await screen.findByText(/couldn.t be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no listings yet/i)).toBeNull();
    // Retry recovers to the truthful empty state.
    api.listOwnListings.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/no listings yet/i)).toBeTruthy();
  });

  it('TRUTHFUL empty: a real [] still says "no listings yet"', async () => {
    api.listOwnListings.mockResolvedValue([]);
    render(<SellerListingsCard />);
    expect(await screen.findByText(/no listings yet/i)).toBeTruthy();
    expect(screen.queryByText(/couldn.t be loaded/i)).toBeNull();
  });
});
