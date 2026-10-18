/**
 * EMPTY-ON-FAIL-8 (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed bindings read is
 * NOT "No event bindings yet".
 *
 * The catch set `bindings` to [], so the empty card ("No event bindings yet …
 * Create your first binding above.") rendered beside the error Notice, inviting a
 * duplicate of a binding that may already exist. The read keeps its own flag: the
 * Notice says why, the list slot offers a Retry, and the empty card needs a
 * successful read.
 *
 * Break it by having the catch write `[]` into `bindings` instead of raising
 * `bindingsFailed` (the original bug: the empty card then renders beside the error);
 * a no-op Retry; or a successful re-read that leaves the old error Notice up.
 * (Dropping the `bindingsFailed ?` branch alone shows the SKELETON, not the empty card —
 * `bindings` stays null on failure — so it reds on the Retry lookup, not on the card.)
 *
 * Twin note: `eventBindingsReadHonesty.test.tsx` is the WORKFLOWS read failing on this
 * page; this file is the BINDINGS read. Case 3 overlaps `EventBindingsPage.test.tsx`
 * 'empty' on the empty card; it is kept (protected) for the no-Retry-on-success half.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type HostClient = typeof import('../../client/hostEventBindingsClient.js');
type WfClient = typeof import('../../workflows/workflowsClient.js');
const host = vi.hoisted(() => ({
  listHostEventBindings: vi.fn<HostClient['listHostEventBindings']>(),
  getHostEventCatalog: vi.fn<HostClient['getHostEventCatalog']>(),
}));
const wf = vi.hoisted(() => ({ listWorkflowSummaries: vi.fn<WfClient['listWorkflowSummaries']>() }));
vi.mock('../../client/hostEventBindingsClient.js', async (orig) => ({
  ...(await orig<HostClient>()),
  listHostEventBindings: host.listHostEventBindings,
  getHostEventCatalog: host.getHostEventCatalog,
}));
vi.mock('../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<WfClient>()),
  listWorkflowSummaries: wf.listWorkflowSummaries,
}));

const { EventBindingsPage } = await import('../EventBindingsPage.js');

const EMPTY_TITLE = 'No event bindings yet';

function view(): void {
  render(<MemoryRouter><EventBindingsPage /></MemoryRouter>);
}

beforeEach(() => {
  host.listHostEventBindings.mockReset();
  host.getHostEventCatalog.mockResolvedValue([]);
  wf.listWorkflowSummaries.mockResolvedValue([]);
});
afterEach(cleanup);

describe('EMPTY-ON-FAIL-8 — a failed bindings read is not "No event bindings yet"', () => {
  it('a rejected read shows the error and a Retry, and NOT "No event bindings yet"', async () => {
    host.listHostEventBindings.mockRejectedValue(new Error('bindings_500'));
    view();
    expect(await screen.findByText('bindings_500')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
  });

  it('Retry re-reads, and a successful empty read then says there are none', async () => {
    host.listHostEventBindings.mockRejectedValueOnce(new Error('bindings_500')).mockResolvedValue([]);
    view();
    await screen.findByText('bindings_500');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.queryByText('bindings_500')).toBeNull();
  });

  // Twin: EventBindingsPage.test 'empty' asserts the empty card's body; this case owns
  // "a clean read offers no Retry".
  it('a successful empty read still says "No event bindings yet" and offers no Retry (positive control)', async () => {
    host.listHostEventBindings.mockResolvedValue([]);
    view();
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
