/**
 * ADR 0905 D3 — the `email-campaign-send` card in the Approvals inbox: the approver sees
 * the PINNED template version's subject and body, the sender, the audience and the
 * estimate, and a stale review says "this campaign changed", not the CMS "page" copy.
 *
 * The stale fixture is the hash-mismatch refusal (`sendApproval.ts`, the check on
 * `expectedContentHash`), the path whose `details` carry `campaignId`. The live-pin refusal
 * after it sends no `campaignId` and still reads as the page copy (ESR-STALE-1,
 * BLOCKED-ON-PRODUCT), so it is not fixtured here.
 *
 * Sabotage (w76 probes): dropping the email group (rows fall into the run table) reds all
 * three; dropping any line of the card reds the first; removing the `campaignId` branch in
 * `approvalErrorInfo` reds the second; approving without the review hash reds the second and
 * third; not re-reading after a 409 reds the third.
 *
 * NYI-EMAIL-1 — `/inbox` is another deciding surface for the same row. It used to show the
 * proposal line only and post no digest, so every approve 409'd as "this campaign changed".
 * The cases below hold the digest AND the content it covers on that card.
 *
 * Sabotage (NYI-EMAIL-1): not sending `reviewHash` or not rendering `EmailSendReviewContext`
 * reds each digest case; dropping `approveDisabled` or the out-of-date line reds both
 * no-digest cases; dropping the email arm of the decide bar reds the note case.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
import type { PendingApproval } from '../../agents/approvalsClient.js';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn<typeof import('../../agents/approvalsClient.js').listApprovals>(),
  listApprovalsByKind: vi.fn<typeof import('../../agents/approvalsClient.js').listApprovalsByKind>(),
  claimApproval: vi.fn<typeof import('../../agents/approvalsClient.js').claimApproval>(),
  rejectApproval: vi.fn<typeof import('../../agents/approvalsClient.js').rejectApproval>(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind, claimApproval, rejectApproval,
}));
const { toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }));
const { loadAgentViews } = vi.hoisted(() => ({ loadAgentViews: vi.fn() }));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/agentViewModel.js')>()),
  loadAgentViews,
}));

import { ApprovalApiError } from '../../agents/approvalsClient.js';
import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';
import { publishReviewSignal } from '../signalBus.js';
import type { Notification } from '../types.js';

const EMAIL_SEND: NonNullable<PendingApproval['emailSend']> = {
  reviewHash: 'full-review-digest',
  campaignId: 'cmp-1', templateId: 'tpl-1', templateVersion: 3, contentHash: 'h', senderAddress: 'news@agency.test',
  audienceHash: 'a', audienceLabel: 'stage: lead', templateName: 'Launch', subject: 'Big launch news', body: 'Hello {{contact.name}}', estimatedRecipients: 42,
};
const ROW: PendingApproval = {
  approvalId: 'e1', rosterId: '', persona: '', workflowId: '',
  kind: 'email-campaign-send', orgId: 'org-1',
  emailSend: EMAIL_SEND,
  proposal: 'Send email campaign "Launch" (stage: lead) from news@agency.test',
  status: 'pending', createdAt: '2026-10-17T00:00:00Z',
};
const STALE = (): ApprovalApiError => new ApprovalApiError('changed', 'conflict', 409, { reason: 'stale_review', campaignId: 'cmp-1' });
const approveButton = { name: t('notifications:approveLabel') };

afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); listApprovalsByKind.mockResolvedValue([]); loadAgentViews.mockResolvedValue([]); });

describe('ADR 0905 D3 — email send review card', () => {
  it('renders what is approved: pinned subject/body, version, sender, audience, estimate', async () => {
    listApprovals.mockResolvedValue([ROW]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    expect(await screen.findByText(t('notifications:approvalsEmailSendGroup'))).toBeTruthy();
    expect(screen.getByText('Big launch news')).toBeTruthy();
    expect(screen.getByText('Hello {{contact.name}}')).toBeTruthy();
    expect(screen.getByText(t('notifications:emailReviewVersion', { version: '3' }))).toBeTruthy();
    expect(screen.getByText(t('notifications:emailReviewFrom', { sender: 'news@agency.test' }))).toBeTruthy();
    expect(screen.getByText(t('notifications:emailReviewAudience', { audience: 'stage: lead' }))).toBeTruthy();
    expect(screen.getByText(t('notifications:emailReviewEstimate', { count: 42, n: '42' }))).toBeTruthy();
  });

  it('a stale review names the campaign, not a page', async () => {
    listApprovals.mockResolvedValue([ROW]);
    claimApproval.mockRejectedValue(STALE());
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', approveButton));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(claimApproval).toHaveBeenCalledWith('e1', undefined, 'full-review-digest');
    expect(toastError).toHaveBeenCalledWith(t('notifications:approvalEmailStale'));
    expect(toastError).not.toHaveBeenCalledWith(t('notifications:approvalStaleReview'));
  });

  it('a refreshed sender/audience repin approves the newly displayed digest', async () => {
    const newer: PendingApproval = { ...ROW, emailSend: { ...EMAIL_SEND, senderAddress: 'other@agency.test', reviewHash: 'repinned-digest' } };
    listApprovals.mockResolvedValueOnce([ROW]).mockResolvedValue([newer]);
    claimApproval.mockRejectedValueOnce(STALE()).mockResolvedValue({});
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', approveButton));
    expect(await screen.findByText(t('notifications:emailReviewFrom', { sender: 'other@agency.test' }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', approveButton));
    await waitFor(() => expect(claimApproval).toHaveBeenCalledTimes(2));
    expect(claimApproval.mock.calls.map((args) => args[2])).toEqual(['full-review-digest', 'repinned-digest']);
  });

  // NYI-EMAIL-1 follow-up — this inbox used to post `undefined` for a digest-less row and
  // show the server's refusal. Sabotage: dropping `approveDisabled` here reds both cases.
  it.each([
    ['no emailSend', (() => { const { emailSend: _dropped, ...row } = ROW; return row; })()],
    ['no reviewHash', (() => { const { reviewHash: _dropped, ...emailSend } = EMAIL_SEND; return { ...ROW, emailSend }; })()],
  ])('%s: Approve is dead and posts nothing, and Reject still works', async (_name, row) => {
    listApprovals.mockResolvedValue([row]);
    rejectApproval.mockResolvedValue(undefined);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    const approve = await screen.findByRole('button', approveButton) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(claimApproval).not.toHaveBeenCalled();
    expect(screen.getByText(t('notifications:emailReviewMissing'))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('notifications:rejectLabel') }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('NYI-EMAIL-1 — the same review on /inbox', () => {
  it('shows what the digest covers, and approves that digest', async () => {
    listApprovals.mockResolvedValue([ROW]);
    claimApproval.mockResolvedValue({});
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    const approve = await screen.findByRole('button', { name: /^Approve$/ });
    expect(screen.getByText('Email campaigns awaiting send approval')).toBeTruthy();
    expect(screen.getByText('Big launch news')).toBeTruthy();
    expect(screen.getByText('Hello {{contact.name}}')).toBeTruthy();
    expect(screen.getByText('Template v3')).toBeTruthy();
    expect(screen.getByText('From news@agency.test')).toBeTruthy();
    expect(screen.getByText(/About 42 recipients \(estimate\)/)).toBeTruthy();
    fireEvent.click(approve);
    await waitFor(() => expect(claimApproval).toHaveBeenCalledWith('e1', undefined, 'full-review-digest'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Approved — the campaign can now be sent.'));
  });

  it('a repin refused as stale shows the new content, then approves the new digest', async () => {
    const newer = { ...ROW, emailSend: { ...EMAIL_SEND, subject: 'Repinned subject', reviewHash: 'repinned-digest' } };
    listApprovals.mockResolvedValueOnce([ROW]).mockResolvedValue([newer]);
    claimApproval.mockRejectedValueOnce(new ApprovalApiError('changed', 'conflict', 409, { reason: 'stale_review', campaignId: 'cmp-1' })).mockResolvedValue({});
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
    expect(await screen.findByText('Repinned subject')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(claimApproval).toHaveBeenCalledTimes(2));
    expect(claimApproval.mock.calls.map((args) => args[2])).toEqual(['full-review-digest', 'repinned-digest']);
  });

  it('a list refresh under an open card shows and approves the new review together', async () => {
    const newer = { ...ROW, emailSend: { ...EMAIL_SEND, subject: 'Refreshed subject', reviewHash: 'refreshed-digest' } };
    listApprovals.mockResolvedValueOnce([ROW]).mockResolvedValue([newer]);
    claimApproval.mockResolvedValue({});
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    expect(await screen.findByText('Big launch news')).toBeTruthy();
    act(() => { publishReviewSignal({} as Notification); });
    expect(await screen.findByText('Refreshed subject')).toBeTruthy();
    expect(screen.queryByText('Big launch news')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(claimApproval).toHaveBeenCalledTimes(1));
    expect(claimApproval).toHaveBeenCalledWith('e1', undefined, 'refreshed-digest');
  });

  it('a request for changes carries the reviewer note and says the campaign is back in draft', async () => {
    listApprovals.mockResolvedValue([ROW]);
    rejectApproval.mockResolvedValue(undefined);
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Reject$/ }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Fix the subject' } });
    fireEvent.click(screen.getByRole('button', { name: t('notifications:rejectSendLabel') }));
    await waitFor(() => expect(rejectApproval).toHaveBeenCalledWith('e1', 'Fix the subject'));
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith('Changes requested — the campaign is back in draft.'));
  });

  it.each([
    ['no emailSend', (() => { const { emailSend: _dropped, ...row } = ROW; return row; })()],
    ['no reviewHash', (() => { const { reviewHash: _dropped, ...emailSend } = EMAIL_SEND; return { ...ROW, emailSend }; })()],
  ])('%s: Approve is dead and posts nothing, and Reject still works', async (_name, row) => {
    listApprovals.mockResolvedValue([row]);
    rejectApproval.mockResolvedValue(undefined);
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    const approve = await screen.findByRole('button', { name: /^Approve$/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(claimApproval).not.toHaveBeenCalled();
    expect(screen.getByText(/out of date and can.t be approved/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Reject$/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
