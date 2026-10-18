/**
 * ADR 0785 P4 — a Claude Code permission prompt reads as what it is, in BOTH
 * inboxes: never "Approve & run" (it starts no run), the verbs are Allow/Deny,
 * and deny takes a REASON because that reason is sent back to Claude Code.
 *
 * Behavioural (w49 rewrite of three source-grep cases): each inbox is RENDERED
 * with a `claude-code-permission` row, and the cases assert what the approver
 * sees and what the decide calls carry. A wrong kind string in either inbox's
 * `isClaudeCodePermission` drops the row into the run catch-all ("Approve &
 * run") — the source greps stayed green on exactly that.
 *
 * CCPERM-TOAST-1 (BLOCKED-ON-PRODUCT, pinned below with `it.fails`): the FULL
 * inbox's approve-toast ladder has no Claude Code arm, so Allow toasts
 * "Approved — {{persona}} is running it now." with an empty persona — the same
 * "it starts a run" claim ADR 0785 P4 removed from the button. NeedsYouInbox
 * says "Approved.", which is the correct copy.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PendingApproval } from '../../agents/approvalsClient.js';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn(), listApprovalsByKind: vi.fn(), claimApproval: vi.fn(), rejectApproval: vi.fn(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind, claimApproval, rejectApproval,
}));
const { loadAgentViews } = vi.hoisted(() => ({ loadAgentViews: vi.fn() }));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/agentViewModel.js')>()),
  loadAgentViews,
}));
const { toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({
  toastSuccess: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn(),
}));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }));

import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const ROW: PendingApproval = {
  approvalId: 'cc1',
  rosterId: '', persona: '', workflowId: '',
  kind: 'claude-code-permission',
  proposal: 'Claude Code wants to use Bash',
  status: 'pending',
  createdAt: '2026-08-20T00:00:00Z',
  claudeCodePermission: { deviceId: 'd1', deviceLabel: 'laptop-7', tool: 'Bash', summary: 'rm -rf build', inputDigest: 'x' },
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  listApprovals.mockResolvedValue([ROW]);
  listApprovalsByKind.mockResolvedValue([]);
  loadAgentViews.mockResolvedValue([]);
});

/** The card reads as a permission, offers Allow/Deny, and no run copy anywhere. */
async function expectPermissionCard(): Promise<void> {
  await screen.findByText('Claude Code on laptop-7 wants to use Bash.');
  expect(screen.getByText('rm -rf build')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Allow$/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Deny$/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /approve & run/i })).toBeNull();
  expect(screen.queryByText(/run workflow/i)).toBeNull();
}

describe('ADR 0785 P4 — the Claude Code permission card', () => {
  it('the full inbox keeps it OUT of the run catch-all and gives it the reasoned bar', async () => {
    rejectApproval.mockResolvedValue(undefined);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await expectPermissionCard();
    // Deny ASKS for the reason first — it goes back to Claude Code verbatim.
    fireEvent.click(screen.getByRole('button', { name: /^Deny$/ }));
    expect(rejectApproval).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Not on this repo' } });
    // The reason step's submit is the button that is not Cancel. Its label is
    // NOT asserted: the shared bar says "Send back to draft" (CMS copy), which
    // is wrong for a permission (CCPERM-DENYCOPY-1, recorded, not pinned here).
    const submit = screen.getAllByRole('button').find((b) => !/^cancel$/i.test(b.textContent?.trim() ?? '') && b.closest('.u-grid') !== null && b.closest('.action-bar') !== null);
    expect(submit).toBeDefined();
    fireEvent.click(submit!);
    await waitFor(() => expect(rejectApproval).toHaveBeenCalledWith('cc1', 'Not on this repo'));
  });

  it('the Needs-you inbox uses the reasoned bar with Allow/Deny for it', async () => {
    claimApproval.mockResolvedValue({});
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    await expectPermissionCard();
    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }));
    await waitFor(() => expect(claimApproval).toHaveBeenCalledWith('cc1', undefined, undefined));
    // What approving DID: allowed a tool — no run.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Approved.'));
  });

  it('the copy exists in all four locales', () => {
    const keys = ['approvalsClaudeCodeGroup', 'approvalsClaudeCodeAsk', 'approvalsClaudeCodeAllow', 'approvalsClaudeCodeDeny'] as const;
    for (const [loc, cat] of [['en', en], ['es', es], ['fr', fr], ['pt-BR', ptBR]] as const) {
      for (const k of keys) {
        const v: unknown = Reflect.get(cat, k);
        expect(typeof v === 'string' && v.length > 0, `${loc}:${k}`).toBe(true);
      }
    }
    expect(en.approvalsClaudeCodeAllow).toBe('Allow');
    expect(en.approvalsClaudeCodeDeny).toBe('Deny');
  });

  // CCPERM-TOAST-1 — BLOCKED-ON-PRODUCT. Asserts the CORRECT outcome; it fails
  // today because ApprovalsInbox toasts "Approved —  is running it now.". When
  // the Claude Code arm lands, this goes red: flip it to `it`.
  it.fails('Allow in the full inbox toasts "Approved.", not a started run (CCPERM-TOAST-1)', async () => {
    claimApproval.mockResolvedValue({});
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Allow$/ }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0]?.[0]).toBe('Approved.');
  });
});
