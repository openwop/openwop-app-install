/**
 * UX_UPGRADE-inbox ROUND 2 — XIB-1: live truth + approval-kind honesty.
 *
 *  - IB-SP-2: the bell + page finally CONSUME connectionStatus — an SSE drop
 *    is visible, never a normal-looking stale inbox.
 *  - IB-SP-3: the tab-focus backfill the emitter's docblock always promised.
 *  - IB-SP-4: NeedsYou renders kind-correct copy — only a RUN proposal earns
 *    "Approve & run"; a content-publish approval renders the server-authored
 *    proposal with a plain Approve and the published toast. (These are
 *    NeedsYouInbox's FIRST tests.)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listApprovals, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn(), claimApproval: vi.fn(), rejectApproval: vi.fn(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, claimApproval, rejectApproval,
}));
const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: vi.fn(), info: vi.fn() } }));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/agentViewModel.js')>()),
}));

import { NeedsYouInbox } from '../NeedsYouInbox.js';
import { NotificationBell } from '../NotificationBell.js';
import { useNotificationStore } from '../notificationStore.js';

const BASE = { rosterId: 'r1', persona: 'Ana', workflowId: 'wf.x', proposal: 'Publish "Summer launch" to the public site?', status: 'pending', createdAt: '2026-08-09T00:00:00Z' };

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe('R2 IB-SP-4 — approval-kind honesty (NeedsYouInbox first tests)', () => {
  it('a content-publish approval renders the server proposal + plain Approve — never "Approve & run"', async () => {
    listApprovals.mockResolvedValue([{ ...BASE, approvalId: 'a1', kind: 'content-publish', pageId: 'p1' }]);
    claimApproval.mockResolvedValue({});
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    await screen.findByText(/Publish "Summer launch"/);
    expect(screen.queryByText(/approve & run/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(claimApproval).toHaveBeenCalledWith('a1'));
    // The toast describes what approving DID: published, not "running".
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/published/i)));
  });

  it('a run-proposal still earns "Approve & run" and the running toast (the positive case)', async () => {
    listApprovals.mockResolvedValue([{ ...BASE, approvalId: 'a2', kind: 'run-proposal' }]);
    claimApproval.mockResolvedValue({ runId: 'run-9' });
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    await screen.findByRole('button', { name: /approve & run/i });
    fireEvent.click(screen.getByRole('button', { name: /approve & run/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/running/i)));
  });

  it('an UNKNOWN kind gets the generic honest card, not run copy', async () => {
    listApprovals.mockResolvedValue([{ ...BASE, approvalId: 'a3', kind: 'warehouse-load', proposal: 'Load 3 files into the warehouse?' }]);
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    await screen.findByText(/Load 3 files/);
    expect(screen.queryByText(/approve & run/i)).toBeNull();
    expect(screen.getByText(/awaiting your approval/i)).toBeTruthy();
  });
});

describe('R2 IB-SP-2 — the SSE drop is visible', () => {
  it('the bell shows the stale badge + label when connectionStatus is error', () => {
    useNotificationStore.setState({ connectionStatus: 'error', unreadCount: 3 });
    render(<NotificationBell />);
    expect(screen.getByRole('button', { name: /reconnecting/i })).toBeTruthy();
    useNotificationStore.setState({ connectionStatus: 'connected' });
  });

  it('a healthy connection shows the normal unread label (the positive case)', () => {
    useNotificationStore.setState({ connectionStatus: 'connected', unreadCount: 3 });
    render(<NotificationBell />);
    expect(screen.queryByRole('button', { name: /reconnecting/i })).toBeNull();
  });
});

describe('R2 IB-SP-3 — tab-focus backfill', () => {
  it('becoming visible triggers a refresh while connected', async () => {
    const refreshSpy = vi.fn(async () => undefined);
    // Drive the real connect() far enough to attach the listener, with the
    // client fully stubbed at the network boundary.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ notifications: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    useNotificationStore.setState({ connectionStatus: 'disconnected', _sseCleanup: null, loading: false, error: null });
    await useNotificationStore.getState().connect();
    useNotificationStore.setState({ refresh: refreshSpy });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(refreshSpy).toHaveBeenCalled();
    useNotificationStore.getState().disconnect();
    vi.unstubAllGlobals();
  });
});
