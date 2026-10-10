/**
 * ADR 0862 D1/D3 — an assistant action card shows what it will send, and approves
 * exactly that.
 *
 *  - D3: both inbox cards rendered only `payload.to`. A human approved a calendar invite
 *    without seeing its time, guests or place (the ADR 0662 opening defect, surviving in
 *    the UI after the server half shipped).
 *  - D1: neither card sent the `contentHash`, so the server's approve-what-you-see check
 *    was skipped on the lane every real approval uses.
 *  - Edit-then-approve: the edit sends the hash it edited, and the card re-reads so the
 *    next approve binds to the NEW hash.
 *
 * `approvalErrorInfo` is NOT mocked — the reason→copy mapping is under test.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval, editAssistantAction } = vi.hoisted(() => ({
  listApprovals: vi.fn(), listApprovalsByKind: vi.fn(async () => []), claimApproval: vi.fn(), rejectApproval: vi.fn(), editAssistantAction: vi.fn(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind, claimApproval, rejectApproval, editAssistantAction,
}));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/agentViewModel.js')>()),
  loadAgentViews: vi.fn(async () => []),
}));
const { toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({
  toastSuccess: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn(),
}));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }));

import { ApprovalApiError } from '../../agents/approvalsClient.js';
import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';

const INVITE = {
  approvalId: 'ap-1',
  rosterId: 'r-cos', persona: 'Iris', workflowId: '',
  kind: 'assistant-action' as const,
  actionId: 'act:1',
  proposal: 'calendar.invite: "Invite Dana"',
  status: 'pending' as const,
  createdAt: '2026-10-07T00:00:00Z',
  action: {
    actionId: 'act:1',
    kind: 'calendar.invite',
    draft: 'Invite Dana to the Q3 review.',
    status: 'pending',
    contentHash: 'hash-v1',
    payload: {
      to: ['dana@example.com'],
      event: {
        summary: 'Q3 review',
        start: { dateTime: '2026-10-09T15:00:00Z' },
        end: { dateTime: '2026-10-09T15:30:00Z' },
        location: 'Room 4',
        attendees: [{ email: 'dana@example.com' }, { email: 'sam@example.com' }],
      },
    },
  },
};

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); listApprovalsByKind.mockResolvedValue([]); });

describe('D3 — the card shows every field the action will send', () => {
  for (const [name, Surface] of [['ApprovalsInbox', ApprovalsInbox], ['NeedsYouInbox', NeedsYouInbox]] as const) {
    it(`${name} renders the invite's title, place and guests — not only its recipient`, async () => {
      listApprovals.mockResolvedValue([INVITE]);
      render(<MemoryRouter><Surface /></MemoryRouter>);
      expect(await screen.findByText('Q3 review')).toBeTruthy();
      expect(screen.getByText('Room 4')).toBeTruthy();
      expect(screen.getByText(/sam@example\.com/)).toBeTruthy();
      // Untrusted provider content is text, never a link.
      expect(screen.queryByRole('link', { name: /Room 4/ })).toBeNull();
    });
  }

  it('an unknown payload key still renders under its raw name (never hidden)', async () => {
    listApprovals.mockResolvedValue([{ ...INVITE, action: { ...INVITE.action, payload: { ...INVITE.action.payload, conferenceUri: 'meet.example/abc' } } }]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    expect(await screen.findByText('conferenceUri')).toBeTruthy();
    expect(screen.getByText('meet.example/abc')).toBeTruthy();
  });
});

describe('D1 — approve echoes the hash of the card shown', () => {
  for (const [name, Surface] of [['ApprovalsInbox', ApprovalsInbox], ['NeedsYouInbox', NeedsYouInbox]] as const) {
    it(`${name} sends expectedContentHash with the claim`, async () => {
      listApprovals.mockResolvedValue([INVITE]);
      claimApproval.mockResolvedValue({ actionId: 'act:1', status: 'approved' });
      render(<MemoryRouter><Surface /></MemoryRouter>);
      await screen.findByText('Q3 review');
      fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
      await waitFor(() => expect(claimApproval).toHaveBeenCalled());
      expect(claimApproval.mock.calls[0]?.[0]).toBe('ap-1');
      expect(claimApproval.mock.calls[0]?.[2]).toBe('hash-v1');
    });
  }

  it('a changed action reads as the localized remedy, and the card re-reads', async () => {
    listApprovals.mockResolvedValue([INVITE]);
    claimApproval.mockRejectedValue(new ApprovalApiError('changed', 'conflict', 409, { reason: 'action_changed' }));
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText('Q3 review');
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/changed after you opened it/i);
    await waitFor(() => expect(listApprovals.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('edit-then-approve binds to the edited bytes', () => {
  it('the edit sends the hash it edited; after the re-read, approve sends the NEW hash', async () => {
    const edited = { ...INVITE, action: { ...INVITE.action, draft: 'Revised invite.', contentHash: 'hash-v2' } };
    listApprovals.mockResolvedValueOnce([INVITE]).mockResolvedValue([edited]);
    editAssistantAction.mockResolvedValue(edited.action);
    claimApproval.mockResolvedValue({ actionId: 'act:1', status: 'approved' });
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText('Q3 review');
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Revised invite.' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(editAssistantAction).toHaveBeenCalled());
    expect(editAssistantAction.mock.calls[0]?.[2]).toBe('hash-v1');
    await screen.findByText('Revised invite.');
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(claimApproval).toHaveBeenCalled());
    expect(claimApproval.mock.calls[0]?.[2]).toBe('hash-v2');
  });
});

describe('UX Blocker — /inbox?approval=<id> lands ON the approval card', () => {
  it('NeedsYouInbox focuses the requested card once the list loads, and reports it', async () => {
    listApprovals.mockResolvedValue([INVITE]);
    const focused = vi.fn();
    render(<MemoryRouter><NeedsYouInbox focusApprovalId="ap-1" onApprovalFocused={focused} /></MemoryRouter>);
    await screen.findByText('Q3 review');
    await waitFor(() => expect(document.activeElement?.id).toBe('approval-card-ap-1'));
    expect(focused).toHaveBeenCalledTimes(1);
  });

  it('an id that is not pending focuses nothing (no stray focus, no report)', async () => {
    listApprovals.mockResolvedValue([INVITE]);
    const focused = vi.fn();
    render(<MemoryRouter><NeedsYouInbox focusApprovalId="ap-gone" onApprovalFocused={focused} /></MemoryRouter>);
    await screen.findByText('Q3 review');
    expect(focused).not.toHaveBeenCalled();
  });
});

describe('UX Blocker — an all-day invite shows the dates it covers', () => {
  it('formats a calendar date in UTC and shows the EXCLUSIVE end as the last day covered', async () => {
    const allDay = { ...INVITE, action: { ...INVITE.action, payload: { event: { summary: 'Offsite', start: { date: '2026-10-09' }, end: { date: '2026-10-10' } } } } };
    listApprovals.mockResolvedValue([allDay]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText('Offsite');
    // Both rows name the 9th: a one-day event, whatever the viewer's offset.
    expect(screen.getAllByText(/Oct 9, 2026 \(all day\)/)).toHaveLength(2);
  });
});

describe('ADR 0862 — a card withheld from a reader who cannot send it', () => {
  for (const [name, Surface] of [['ApprovalsInbox', ApprovalsInbox], ['NeedsYouInbox', NeedsYouInbox]] as const) {
    it(`${name} says why and offers no decision`, async () => {
      listApprovals.mockResolvedValue([{ ...INVITE, action: { actionId: 'act:1', kind: 'calendar.invite', status: 'pending', withheld: true } }]);
      render(<MemoryRouter><Surface /></MemoryRouter>);
      expect(await screen.findByText(/Only members who can send this action/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
    });
  }
});

describe('D3 — familiar field formatting preserves the complete sent value', () => {
  for (const [name, Surface] of [['ApprovalsInbox', ApprovalsInbox], ['NeedsYouInbox', NeedsYouInbox]] as const) {
    it(`${name} shows attendee/time extras and explicit data-clearing values`, async () => {
      listApprovals.mockResolvedValue([{
        ...INVITE,
        action: { ...INVITE.action, payload: { to: [], event: {}, patch: {
          start: { dateTime: '2026-10-09T15:00:00', timeZone: 'Pacific/Auckland', customHint: 'keep this zone' },
          end: { dateTime: '2026-10-09T15:30:59.123Z', timeZone: 'UTC' },
          attendees: [{ email: 'dana@example.com', displayName: 'Dana Rivera', optional: true, resource: false }],
          description: '', conferenceData: null, reminders: { useDefault: false },
        } } },
      }]);
      render(<MemoryRouter><Surface /></MemoryRouter>);
      expect(await screen.findByText(/Pacific\/Auckland/)).toBeTruthy();
      expect(screen.getByText(/Pacific\/Auckland/).textContent).toContain('2026-10-09T15:00:00');
      expect(screen.getByText(/keep this zone/)).toBeTruthy();
      expect(screen.getByText(/"timeZone":"UTC"/)).toBeTruthy();
      expect(screen.getByText(/"timeZone":"UTC"/).textContent).toContain('2026-10-09T15:30:59.123Z');
      expect(screen.getByText(/Dana Rivera/).textContent).toContain('"optional":true');
      expect(screen.getByText(/Dana Rivera/).textContent).toContain('"resource":false');
      expect(screen.getByText('""')).toBeTruthy();
      expect(screen.getByText('null')).toBeTruthy();
      expect(screen.getByText('{"useDefault":false}')).toBeTruthy();
      expect(screen.getByText('[]')).toBeTruthy();
      expect(screen.getByText('{}')).toBeTruthy();
    });
  }
});
