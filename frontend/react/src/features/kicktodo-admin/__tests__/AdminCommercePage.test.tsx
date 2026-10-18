/**
 * KTUX-6 — the operator seat-repair surface. Pins the honesty contract the
 * reviewer flagged: `reconcile-seats` returns the post-state with NO delta, so
 * the UI must render "seats now N of M" and MUST NOT mirror the commerce
 * reconcile's fabricated "repaired N" copy.
 *
 * Sabotage witnesses (w40 probes): rendering `capacity` as `taken`, calling
 * `reconcileSeats` with an id other than the typed one, or dropping the
 * `!circleId.trim()` disable gate each turn a case here red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PayoutRun, SharePolicy } from '../../../client/kicktodoSeatClient.js';

type SeatReconcileResult = { circleId: string; seatsTaken: number; capacity: number };
const state = {
  reconcileSeats: vi.fn(async (_id: string): Promise<SeatReconcileResult> => ({ circleId: 'circle:x', seatsTaken: 4, capacity: 10 })),
};
const RUN_CONFIRMED: PayoutRun = { runId: 'r', state: 'confirmed', entries: [], createdAt: '' };
const RUN_CANCELED: PayoutRun = { runId: 'r', state: 'canceled', entries: [], createdAt: '' };
vi.mock('../../../client/kicktodoSeatClient.js', () => ({
  reconcileCommerce: vi.fn(async (): Promise<{ ordersScanned: number; entitlementsRepaired: number }> => ({ ordersScanned: 0, entitlementsRepaired: 0 })),
  reconcileSeats: (id: string) => state.reconcileSeats(id),
  // ADR 0445 P3/P4 payout panel surface (not exercised by these seat tests).
  getSharePolicy: vi.fn(async (): Promise<SharePolicy | null> => null),
  setSharePolicy: vi.fn(async (): Promise<SharePolicy> => ({ shareBps: 0, version: 1 })),
  listPayoutRuns: vi.fn(async (): Promise<PayoutRun[]> => []),
  createPayoutRun: vi.fn(async (): Promise<PayoutRun | null> => null),
  confirmPayoutRun: vi.fn(async (): Promise<PayoutRun> => RUN_CONFIRMED),
  cancelPayoutRun: vi.fn(async (): Promise<PayoutRun> => RUN_CANCELED),
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
    const btn = screen.getByText('Reconcile seats').closest('button')!;
    // The other arm of the disable gate: a typed id makes the CTA usable.
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    // The EXACT post-state copy is the guard against a fabricated delta: the
    // seat result never renders the commerce "Repaired N" phrasing.
    await waitFor(() => expect(screen.getByText('Seats now 4 of 10.')).toBeTruthy());
    expect(state.reconcileSeats).toHaveBeenCalledWith('circle:abc');
  });

  it('the reconcile button is disabled until a circle id is entered', () => {
    renderPage();
    const btn = screen.getByText('Reconcile seats').closest('button')!;
    expect(btn.disabled).toBe(true);
  });
});
