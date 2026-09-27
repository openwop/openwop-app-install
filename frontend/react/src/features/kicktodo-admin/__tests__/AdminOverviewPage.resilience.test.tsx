import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listExceptions } = vi.hoisted(() => ({ listExceptions: vi.fn() }));
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
});
afterEach(cleanup);

describe('KickTodo admin overview resilience', () => {
  it('turns a rejected exception-ledger read into an announced retryable state', async () => {
    listExceptions
      .mockRejectedValueOnce(new Error('ledger down'))
      .mockResolvedValueOnce({ rows: [], sources: [] });
    render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>);

    const failure = await screen.findByText(/could not load the exception ledger/i);
    const card = failure.closest('.state-card');
    expect(card).toBeTruthy();
    fireEvent.click(card!.querySelector('button')!);

    await waitFor(() => expect(screen.queryByText(/could not load the exception ledger/i)).toBeNull());
    expect(screen.getByText(/nothing needs attention right now/i)).toBeTruthy();
    expect(listExceptions).toHaveBeenCalledTimes(2);
  });
});
