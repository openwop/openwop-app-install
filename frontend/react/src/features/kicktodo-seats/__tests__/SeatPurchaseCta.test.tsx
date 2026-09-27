/**
 * G4 (chat-first port) — the seat purchase page no longer dead-ends at Pay.
 * With a live hold AND a resolved product org, the Pay step renders a real
 * checkout CTA deep-linking the buyer to `/store/:orgId` (ADR 0455 P2 pattern);
 * without an org it stays copy-only rather than offering a dead link.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { SeatAvailability } from '../../../client/kicktodoSeatClient.js';

const state = { availability: null as SeatAvailability | null };
vi.mock('../../../client/kicktodoSeatClient.js', () => ({
  getSeatAvailability: vi.fn(async () => state.availability),
  reserveSeat: vi.fn(async () => true),
}));

import { SeatPurchasePage } from '../SeatPurchasePage.js';

const heldSeat = (over: Partial<SeatAvailability> = {}): SeatAvailability => ({
  capacity: 10, seatsTaken: 7, seatsLeft: 3, heldByYou: true,
  holdExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  challengeTitle: 'Sunrise cohort', startDateLocal: '2026-08-01',
  ...over,
});

const renderAt = () => render(
  <MemoryRouter initialEntries={['/kicktodo/seats/prod-1']}>
    <Routes><Route path="/kicktodo/seats/:productId" element={<SeatPurchasePage />} /></Routes>
  </MemoryRouter>,
);

afterEach(() => { cleanup(); state.availability = null; });

describe('SeatPurchasePage — G4 checkout CTA', () => {
  it('renders a /store/:orgId checkout link when a seat is held and the org resolves', async () => {
    state.availability = heldSeat({ orgId: 'org-9' });
    renderAt();
    const link = await waitFor(() => screen.getByRole('link'));
    expect(link.getAttribute('href')).toBe('/store/org-9');
  });

  it('shows NO checkout link when the product org is absent (no dead link)', async () => {
    state.availability = heldSeat({ orgId: undefined });
    renderAt();
    // Wait for the held-seat panel to render, then assert the CTA is not present.
    await waitFor(() => expect(screen.getByText('Sunrise cohort')).toBeTruthy());
    expect(screen.queryByRole('link')).toBeNull();
  });
});
