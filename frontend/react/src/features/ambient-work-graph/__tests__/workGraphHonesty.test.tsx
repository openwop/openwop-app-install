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
 *
 * Sabotage-witnessed (w52): dropping the `if (error)` failure card, a Retry
 * that does not re-read, removing the row before the await (optimistic), and
 * removing it inside the catch (the failed case now waits for the failure
 * toast — the settle signal — before it looks, so a late removal is seen).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Client = typeof import('../workGraphClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<Client['listOrgs']>(), listSuggestions: vi.fn<Client['listSuggestions']>(),
  refreshSuggestions: vi.fn<Client['refreshSuggestions']>(),
  dismissSuggestion: vi.fn<Client['dismissSuggestion']>(), acceptSuggestion: vi.fn<Client['acceptSuggestion']>(),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../workGraphClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
vi.mock('../../../ui/toast.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../ui/toast.js')>();
  return { ...orig, toast: { ...orig.toast, error: toastError } };
});

import { WorkGraphPage } from '../WorkGraphPage.js';
import type { WorkflowSuggestion } from '../workGraphClient.js';

// A COMPLETE fixture (the recurring lesson: an incomplete one throws inside
// render and fails every assertion for an unrelated reason).
// Typed against the real shape: `status` is one of the client's three values
// (the round-1 fixture used an impossible 'open', hidden by a cast).
const SUGGESTION: WorkflowSuggestion = {
  suggestionId: 'sg1',
  tenantId: 't1',
  signature: 'email.send>kb.search',
  sampleGoal: 'Weekly digest',
  toolSequence: ['email.send', 'kb.search'],
  count: 4,
  exampleRunIds: ['r1', 'r2'],
  status: 'suggested',
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-02T00:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
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
    // A failed read is not "no patterns yet" (the empty state).
    expect(screen.queryByText('No patterns yet')).toBeNull();
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
    // Wait for the failure to SETTLE (its toast) before looking — the call
    // fires synchronously on click, so asserting right after it ran before the
    // rejection was handled and could not see a removal inside the catch.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('dismiss_500'));
    expect((screen.getByRole('button', { name: /dismiss/i }) as HTMLButtonElement).disabled).toBe(false);
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
