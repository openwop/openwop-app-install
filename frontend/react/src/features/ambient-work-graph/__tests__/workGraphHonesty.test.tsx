/**
 * AWG-R2-1 (ambient-work-graph round 2) — the page's two verified-clean
 * invariants finally get their pinning tests.
 *
 * Two prior passes (07-25 + worklist pass 11) read this page CLEAN — real
 * errors on both reads, server-first dismiss ("persisted; never resurrected
 * by a re-sweep") — but recorded "no dedicated test files" both times. A
 * verdict without a probe decays; these pin it:
 *
 *  1. A failed suggestions read sets a REAL error (never "no patterns yet").
 *  2. Dismiss is SERVER-FIRST: the row leaves the list only after the server
 *     accepts; a failed dismiss keeps the suggestion visible (no optimistic
 *     lie about a persisted dismissal).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(), listSuggestions: vi.fn(), refreshSuggestions: vi.fn(),
  dismissSuggestion: vi.fn(), acceptSuggestion: vi.fn(),
}));
vi.mock('../workGraphClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { WorkGraphPage } from '../WorkGraphPage.js';

// A COMPLETE fixture (the recurring lesson: an incomplete one throws inside
// render and fails every assertion for an unrelated reason).
const SUGGESTION = {
  suggestionId: 'sg1',
  sampleGoal: 'Weekly digest',
  toolSequence: ['email.send', 'kb.search'],
  count: 4,
  exampleRunIds: ['r1', 'r2'],
  status: 'open',
} as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  api.listSuggestions.mockResolvedValue([SUGGESTION]);
});
afterEach(cleanup);

function view(): void {
  render(<MemoryRouter><WorkGraphPage /></MemoryRouter>);
}

describe('AWG-R2-1 — work-patterns honesty, pinned', () => {
  it('a failed FIRST read shows a failure card with retry — NOT a permanent loading card', async () => {
    // The defect this test caught on write: the error was set but the
    // suggestions===null early-return rendered the loading card forever, so
    // the error message was unreachable (failure-as-LOADING).
    api.listSuggestions.mockRejectedValueOnce(new Error('patterns_500'));
    view();
    expect(await screen.findByText(/patterns_500/)).toBeTruthy();
    expect(screen.getByText(/Couldn.t load work patterns/i)).toBeTruthy();
    // Retry recovers: the next read succeeds and the real suggestions render.
    api.listSuggestions.mockResolvedValue([SUGGESTION]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/Weekly digest/)).toBeTruthy();
    expect(screen.queryByText(/patterns_500/)).toBeNull();
  });

  it('dismiss is server-first: a FAILED dismiss keeps the suggestion visible', async () => {
    api.dismissSuggestion.mockRejectedValue(new Error('dismiss_500'));
    view();
    const dismiss = await screen.findByRole('button', { name: /dismiss/i });
    fireEvent.click(dismiss);
    await waitFor(() => expect(api.dismissSuggestion).toHaveBeenCalledWith('o1', 'sg1'));
    // The suggestion must STILL be on screen — removing it would claim a
    // persisted dismissal that never happened (and a re-sweep would
    // "resurrect" it, breaking the docstring's promise the other way).
    expect(screen.getByText(/Weekly digest/)).toBeTruthy();
  });

  it('a successful dismiss removes the row (the polarity that keeps the test honest)', async () => {
    api.dismissSuggestion.mockResolvedValue(undefined);
    view();
    const dismiss = await screen.findByRole('button', { name: /dismiss/i });
    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.queryByText(/Weekly digest/)).toBeNull());
  });
});
