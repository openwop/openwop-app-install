/**
 * ADR 0460 Phase 2 — the console's Exception Ledger must never turn a failed read
 * into a silent "all clear". A failed `listExceptions()` (the client resolves
 * `null`) renders an ANNOUNCED
 * failure card (StateCard `announce` → the polite GlobalLiveRegion) with a Retry
 * that re-reads and recovers.
 *
 * Sabotage witnesses (w40 probes): mapping the failure to an empty ledger, a
 * no-op Retry, or dropping `announce` from the failure card each turn this red.
 * The announcement is awaited, not read synchronously: dropping `announce`
 * still reds it (waitFor times out), it just no longer races the effect flush.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { announce, currentAnnouncements } from '../../../ui/announce.js';
import type { ExceptionLedger } from '../../../client/kicktodoExceptionsClient.js';
import { MemoryRouter } from 'react-router-dom';

const { listExceptions } = vi.hoisted(() => ({ listExceptions: vi.fn<() => Promise<ExceptionLedger | null>>() }));
const reviewStore = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  loading: false,
  initialized: true,
};

vi.mock('../../../client/kicktodoExceptionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listExceptions,
}));
vi.mock('../../../chat/reviews/reviewStatusStore.js', () => ({
  useReviewStatusStore: (selector: (state: typeof reviewStore) => unknown) => selector(reviewStore),
  useReviewList: () => [],
}));

import { AdminOverviewPage } from '../AdminOverviewPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  // The live region is module-level state: clear it so a prior case's text
  // cannot satisfy this file's announcement assertion.
  announce('');
});
afterEach(cleanup);

describe('KickTodo admin overview resilience', () => {
  it('turns a failed (null) exception-ledger read into an announced retryable state', async () => {
    // The REAL client never rejects: `listExceptions()` maps any failed read to
    // `null` (kicktodoExceptionsClient.ts). Fixture the failure the way
    // production delivers it, not as a rejection only the page's defensive
    // catch would ever see.
    listExceptions
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ rows: [], sources: [] });
    render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>);

    const failure = await screen.findByText(/could not load the exception ledger/i);
    // StateCard announces from a passive effect, which React may flush a tick
    // after the card's text is in the DOM. Under load the findBy above can
    // observe that gap, so wait for the announcement rather than reading it
    // synchronously (the '' Received seen in b1's clockshift run).
    await waitFor(() => expect(currentAnnouncements().polite).toContain('Could not load the exception ledger.'));
    const card = failure.closest('.state-card');
    expect(card).toBeTruthy();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByText(/could not load the exception ledger/i)).toBeNull());
    expect(screen.getByText(/nothing needs attention right now/i)).toBeTruthy();
    expect(listExceptions).toHaveBeenCalledTimes(2);
  });
});
