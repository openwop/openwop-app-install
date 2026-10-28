/**
 * ADR 0905 D3 — the `email-campaign-send` card in the Approvals inbox: the approver sees
 * the PINNED template version's subject and body, the sender, the audience and the
 * estimate, and a stale review says "this campaign changed", not the CMS "page" copy.
 *
 * Sabotage-witnessed: dropping the email group (rows fall into the run table) reds the
 * first case; removing the `campaignId` branch in `approvalErrorInfo` reds the second.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn(), listApprovalsByKind: vi.fn(), claimApproval: vi.fn(), rejectApproval: vi.fn(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind, claimApproval, rejectApproval,
}));
const { toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }));

import { ApprovalApiError } from '../../agents/approvalsClient.js';
import { ApprovalsInbox } from '../ApprovalsInbox.js';

const ROW = {
  approvalId: 'e1', rosterId: '', persona: '', workflowId: '',
  kind: 'email-campaign-send' as const, orgId: 'org-1',
  emailSend: {
    reviewHash: 'full-review-digest',
    campaignId: 'cmp-1', templateId: 'tpl-1', templateVersion: 3, contentHash: 'h', senderAddress: 'news@agency.test',
    audienceHash: 'a', audienceLabel: 'stage: lead', templateName: 'Launch', subject: 'Big launch news', body: 'Hello {{contact.name}}', estimatedRecipients: 42,
  },
  proposal: 'Send email campaign "Launch" (stage: lead) from news@agency.test',
  status: 'pending' as const, createdAt: '2026-10-17T00:00:00Z',
};

afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); listApprovalsByKind.mockResolvedValue([]); });

describe('ADR 0905 D3 — email send review card', () => {
  it('renders what is approved: pinned subject/body, version, sender, audience, estimate', async () => {
    listApprovals.mockResolvedValue([ROW]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    expect(await screen.findByText('Email campaigns awaiting send approval')).toBeTruthy();
    expect(screen.getByText('Big launch news')).toBeTruthy();
    expect(screen.getByText('Hello {{contact.name}}')).toBeTruthy();
    expect(screen.getByText('Template v3')).toBeTruthy();
    expect(screen.getByText('From news@agency.test')).toBeTruthy();
    expect(screen.getByText(/About 42 recipients \(estimate\)/)).toBeTruthy();
  });

  it('a stale review names the campaign, not a page', async () => {
    listApprovals.mockResolvedValue([ROW]);
    claimApproval.mockRejectedValue(new ApprovalApiError('changed', 'conflict', 409, { reason: 'stale_review', campaignId: 'cmp-1' }));
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(claimApproval).toHaveBeenCalledWith('e1', undefined, 'full-review-digest');
    expect(String(toastError.mock.calls[0]![0])).toMatch(/campaign changed after it was submitted/);
  });

  it('a refreshed sender/audience repin approves the newly displayed digest', async () => {
    const newer = { ...ROW, emailSend: { ...ROW.emailSend, senderAddress: 'other@agency.test', reviewHash: 'repinned-digest' } };
    listApprovals.mockResolvedValueOnce([ROW]).mockResolvedValue([newer]);
    claimApproval.mockRejectedValueOnce(new ApprovalApiError('changed', 'conflict', 409, { reason: 'stale_review', campaignId: 'cmp-1' })).mockResolvedValue({});
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
    expect(await screen.findByText('From other@agency.test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(claimApproval).toHaveBeenCalledTimes(2));
    expect(claimApproval.mock.calls.map((args) => args[2])).toEqual(['full-review-digest', 'repinned-digest']);
  });
});
