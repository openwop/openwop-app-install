/**
 * CS-4 (KickTodo UX-ASSESSMENT) — a failed cohort read offers a way back
 * (DESIGN.md §4.6): the error carries a Retry that re-runs the read, and the
 * in-flight retry shows loading, never the "not found" empty state the failed
 * read left `availability` at. The failed read itself is not "not found" either.
 *
 * Breaks it: dropping the Retry button; a Retry that does not re-read
 * (sabotage-witnessed: onClick reduced to a no-op turns the cohort assertion
 * red); a Retry that keeps `loaded` true (sabotage-witnessed: removing
 * `setLoaded(false)` renders the "not found" card mid-retry); the not-found
 * card shown beside the error (its `!error` guard dropped).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { SeatAvailability } from '../../../client/kicktodoSeatClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as commonEn } from '../../../i18n/locales/en/common.js';

const seat = vi.hoisted(() => ({
  getSeatAvailability: vi.fn<(productId: string) => Promise<SeatAvailability | null>>(),
}));
vi.mock('../../../client/kicktodoSeatClient.js', () => ({
  getSeatAvailability: seat.getSeatAvailability,
  reserveSeat: vi.fn<(productId: string) => Promise<boolean>>(async () => true),
}));

import { SeatPurchasePage } from '../SeatPurchasePage.js';

const COHORT: SeatAvailability = {
  capacity: 10, seatsTaken: 7, seatsLeft: 3, heldByYou: false,
  challengeTitle: 'Sunrise cohort', challengeId: 'chal:sunrise', startDateLocal: '2026-08-01',
};

const renderAt = () => render(
  <MemoryRouter initialEntries={['/kicktodo/seats/prod-1']}>
    <Routes><Route path="/kicktodo/seats/:productId" element={<SeatPurchasePage />} /></Routes>
  </MemoryRouter>,
);

afterEach(() => { cleanup(); seat.getSeatAvailability.mockReset(); });

describe('SeatPurchasePage — failed read recovery (CS-4)', () => {
  it('Retry re-reads the cohort; the in-flight retry is loading, not "not found"', async () => {
    let release: (v: SeatAvailability) => void = () => {};
    seat.getSeatAvailability
      .mockRejectedValueOnce(new Error('seat availability failed: 503'))
      .mockImplementationOnce(() => new Promise<SeatAvailability>((r) => { release = r; }));
    renderAt();
    await waitFor(() => expect(screen.getByText(en.loadError)).toBeTruthy());
    expect(screen.queryByText(en.notFoundTitle)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: commonEn.retry }));
    await waitFor(() => expect(screen.queryByText(en.loadError)).toBeNull());
    // Positive signal first: the retry is showing the loading card.
    expect(document.querySelector('.state-card[aria-busy="true"]')).not.toBeNull();
    // Mid-retry: the failed read must not be re-presented as an absent cohort.
    expect(screen.queryByText(en.notFoundTitle)).toBeNull();

    release(COHORT);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sunrise cohort' })).toBeTruthy());
    expect(seat.getSeatAvailability).toHaveBeenCalledTimes(2);
    expect(seat.getSeatAvailability).toHaveBeenLastCalledWith('prod-1');
  });
});
