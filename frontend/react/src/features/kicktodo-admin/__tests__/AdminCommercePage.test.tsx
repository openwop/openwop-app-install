/**
 * KTUX-6 — the operator seat-repair surface. Pins the honesty contract the
 * reviewer flagged: `reconcile-seats` returns the post-state with NO delta, so
 * the UI must render "seats now N of M" and MUST NOT mirror the commerce
 * reconcile's fabricated "repaired N" copy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = {
  reconcileSeats: vi.fn(async (_id: string) => ({ circleId: 'circle:x', seatsTaken: 4, capacity: 10 })),
};
vi.mock('../../../client/kicktodoSeatClient.js', () => ({
  reconcileCommerce: vi.fn(async () => ({ ordersScanned: 0, entitlementsRepaired: 0 })),
  reconcileSeats: (id: string) => state.reconcileSeats(id),
  // ADR 0445 P3/P4 payout panel surface (not exercised by these seat tests).
  getSharePolicy: vi.fn(async () => null),
  setSharePolicy: vi.fn(async () => ({ shareBps: 0, version: 1 })),
  listPayoutRuns: vi.fn(async () => []),
  createPayoutRun: vi.fn(async () => null),
  confirmPayoutRun: vi.fn(async () => ({ runId: 'r', state: 'confirmed', entries: [], createdAt: '' })),
  cancelPayoutRun: vi.fn(async () => ({ runId: 'r', state: 'canceled', entries: [], createdAt: '' })),
  shareLedgerCsvUrl: '/test/share-ledger.csv',
  earningsCsvUrl: '/test/my-earnings.csv',
}));

import { AdminCommercePage } from '../AdminCommercePage.js';

const renderPage = () => render(<MemoryRouter><AdminCommercePage /></MemoryRouter>);
afterEach(cleanup);

describe('AdminCommercePage — seat reconcile', () => {
  it('reconciles a pasted circle id and reports the post-state (not a fabricated repair count)', async () => {
    renderPage();
    const input = screen.getByLabelText('Cohort circle id');
    fireEvent.change(input, { target: { value: 'circle:abc' } });
    fireEvent.click(screen.getByText('Reconcile seats'));

    await waitFor(() => expect(screen.getByText('Seats now 4 of 10.')).toBeTruthy());
    expect(state.reconcileSeats).toHaveBeenCalledWith('circle:abc');
    // The commerce "repaired N" phrasing must not appear for the seat result.
    expect(screen.queryByText(/Repaired/i)).toBeNull();
  });

  it('the reconcile button is disabled until a circle id is entered', () => {
    renderPage();
    const btn = screen.getByText('Reconcile seats').closest('button')!;
    expect(btn.disabled).toBe(true);
  });
});
