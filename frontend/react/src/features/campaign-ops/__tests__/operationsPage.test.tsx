/**
 * ADR 0926 P0 — the Operations inbox.
 *
 *   - a preview client carries the "nothing is written" banner; a live one does not;
 *   - the mode switch shows only for an agency admin;
 *   - a duplicate submit offers "send anyway" and re-sends with the reason;
 *   - a change set in review approves with the change set's hash in the body, and
 *     a 403 / 409 shows the server's own words;
 *   - the change is shown before → after, with step reasons in plain words;
 *   - a failed clients read is said, never shown as "no clients";
 *   - ADR 0924 D5: under client approval the in-review card sends links instead of
 *     approving; the approvers panel shows only while the portal is on.
 *
 * Sabotage-witnessed (wave 55/56 probes, each red here): the mode switch shown
 * to non-admins; the banner shown for a live client; a failed read rendered as
 * no clients; the duplicate flag or the override reason dropped; the change
 * set's id approved instead of its hash; the server's words replaced by our
 * fallback on a 403 or on a 409; unknown step reasons not mapped; splitChange's
 * prefix scan disabled, or its suffix scan allowed to overlap the prefix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

// The page keeps its view in `?view=` (ADR 0943 P4), so it renders inside a router.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

type Client = typeof import('../campaignOpsClient.js');
const h = vi.hoisted(() => ({
  listClients: vi.fn<Client['listClients']>(), updateClient: vi.fn<Client['updateClient']>(),
  listAssets: vi.fn<Client['listAssets']>(), listRequests: vi.fn<Client['listRequests']>(),
  submitRequest: vi.fn<Client['submitRequest']>(), answerQuestions: vi.fn<Client['answerQuestions']>(),
  reviseRequest: vi.fn<Client['reviseRequest']>(), listChangeSets: vi.fn<Client['listChangeSets']>(),
  getChangeSetDiff: vi.fn<Client['getChangeSetDiff']>(), requestApproval: vi.fn<Client['requestApproval']>(),
  listJobs: vi.fn<Client['listJobs']>(), approveChangeSet: vi.fn<Client['approveChangeSet']>(),
  rejectChangeSet: vi.fn<Client['rejectChangeSet']>(),
  getTeam: vi.fn<Client['getTeam']>(),
  listApprovers: vi.fn<Client['listApprovers']>(), addApprover: vi.fn<Client['addApprover']>(),
  removeApprover: vi.fn<Client['removeApprover']>(), sendApprovalLinks: vi.fn<Client['sendApprovalLinks']>(),
}));
vi.mock('../campaignOpsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));
vi.mock('../ClientReportsSection.js', () => ({ ClientReportsSection: () => null })); // own tests: clientReportsSection.test.tsx
vi.mock('../ClientIntakeSection.js', () => ({ ClientIntakeSection: () => null })); // own tests: clientIntakeSection.test.tsx
vi.mock('../ClientCollabAuditSection.js', () => ({ ClientCollabAuditSection: () => null })); // own tests: clientCollabAuditSection.test.tsx
vi.mock('../ClientCollaboratorsPanel.js', () => ({ ClientCollaboratorsPanel: () => null })); // own tests: clientCollaboratorsPanel.test.tsx
// ADR 0944 — the Client memory panel has its own test (clientMemoryPanel.test.tsx).
vi.mock('../ClientMemoryPanel.js', () => ({ ClientMemoryPanel: () => null }));

import { OperationsPage, stepReasonKey } from '../OperationsPage.js';
import { splitChange } from '../ChangeDiff.js';
import { CampaignOpsError, type ChangeRequest, type ChangeSet, type ClientAccount } from '../campaignOpsClient.js';

const client = (mode: 'preview' | 'live'): ClientAccount => ({ tenantId: 't', orgId: 'o1', displayName: 'Acme', status: 'active', mode, approvalPolicy: 'agency', createdAt: '', updatedAt: '' });
const cs: ChangeSet = { changeSetId: 'cs1', requestId: 'r1', requestVersion: 1, entries: [], hash: 'h-123', status: 'in_review', createdAt: '' };
const request = (status: ChangeRequest['status']): ChangeRequest => ({
  requestId: 'r1', orgId: 'o1', version: 1, text: 'New headline', assetIds: ['a1'], answers: [], status,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.listClients.mockResolvedValue({ clients: [client('preview')], agencyAdmin: false });
  h.listAssets.mockResolvedValue([{ assetId: 'a1', orgId: 'o1', destination: 'openwop.cms.page', locator: { pageId: 'p' }, label: 'Home page', editableFields: [] }]);
  h.listRequests.mockResolvedValue([]);
  h.listChangeSets.mockResolvedValue([]);
  h.listJobs.mockResolvedValue([]);
  h.listApprovers.mockResolvedValue({ approvers: [], portalEnabled: false });
});
afterEach(cleanup);

describe('OperationsPage', () => {
  it('shows the preview banner for a preview client and hides the mode switch from non-admins', async () => {
    render(<OperationsPage />);
    expect(await screen.findByText('Preview: nothing is written.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Switch to live' })).toBeNull();
  });

  it('a live client has no banner; an admin sees the switch', async () => {
    h.listClients.mockResolvedValue({ clients: [client('live')], agencyAdmin: true });
    render(<OperationsPage />);
    expect(await screen.findByRole('button', { name: 'Switch back to preview' })).toBeTruthy();
    expect(screen.queryByText('Preview: nothing is written.')).toBeNull();
  });

  it('ADR 0962 D7: an admin picks what outside agents may do; nothing saves until Apply, and Apply saves once', async () => {
    h.listClients.mockResolvedValue({ clients: [client('live')], agencyAdmin: true });
    h.updateClient.mockResolvedValue({ ...client('live'), externalAgents: 'read' });
    render(<OperationsPage />);
    const select = await screen.findByLabelText('Outside AI agents');
    expect((select as HTMLSelectElement).value).toBe('off');
    // Arrowing through the options changes the value; it must not save.
    fireEvent.change(select, { target: { value: 'request' } });
    fireEvent.change(select, { target: { value: 'read' } });
    expect(h.updateClient).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(h.updateClient).toHaveBeenCalledTimes(1));
    expect(h.updateClient).toHaveBeenCalledWith('o1', { externalAgents: 'read' });
  });

  it('a staged outside-agent permission never follows a switch to another client', async () => {
    h.listClients.mockResolvedValue({ clients: [client('live'), { ...client('live'), orgId: 'o2', displayName: 'Beta', externalAgents: 'read' }], agencyAdmin: true });
    render(<OperationsPage />);
    fireEvent.change(await screen.findByLabelText('Outside AI agents'), { target: { value: 'request' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'o2' } });
    await waitFor(() => expect((screen.getByLabelText('Outside AI agents') as HTMLSelectElement).value).toBe('read'));
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(h.updateClient).not.toHaveBeenCalled();
  });

  it('a non-admin does not see the outside-agents control', async () => {
    render(<OperationsPage />);
    await screen.findByText('Home page');
    expect(screen.queryByLabelText('Outside AI agents')).toBeNull();
  });

  it('the Team tab loads the client team on demand (ADR 0943 P4)', async () => {
    h.getTeam.mockResolvedValue({ canEdit: false, evals: { available: true }, members: [] });
    render(<OperationsPage />);
    expect(h.getTeam).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
    expect(await screen.findByText('Campaign team for Acme')).toBeTruthy();
    expect(h.getTeam).toHaveBeenCalledWith('o1');
  });

  it('a failed clients read is said, not shown as no clients', async () => {
    h.listClients.mockRejectedValue(new CampaignOpsError('boom', 500));
    render(<OperationsPage />);
    expect(await screen.findByText("Couldn't load your clients")).toBeTruthy();
    expect(screen.queryByText('No clients yet')).toBeNull();
  });

  it('a duplicate submit offers send anyway, which re-sends with the reason', async () => {
    h.submitRequest.mockResolvedValueOnce({ request: request('duplicate'), duplicate: true }).mockResolvedValueOnce({ request: request('interpreting'), duplicate: false });
    render(<OperationsPage />);
    await screen.findByLabelText('Home page');
    fireEvent.change(screen.getByLabelText('Describe the change'), { target: { value: 'New headline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findAllByText('This looks like a request you already made');
    // The first submit carried no override.
    expect(h.submitRequest.mock.calls[0]).toEqual(['o1', { text: 'New headline', assetIds: ['a1'] }]);
    fireEvent.change(screen.getByLabelText('Why send it again?'), { target: { value: 'client asked twice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    await waitFor(() => expect(h.submitRequest).toHaveBeenLastCalledWith('o1', { text: 'New headline', assetIds: ['a1'], overrideDuplicate: { reason: 'client asked twice' } }));
    expect(h.submitRequest).toHaveBeenCalledTimes(2);
  });

  it('approves a change in review with its hash and shows the diff; a 403 shows the server words', async () => {
    // The server's words DIFFER from our fallbacks (forbiddenSelfApproval /
    // conflictReload), so showing a fallback instead is red.
    const FORBIDDEN = 'Approver must be someone other than the requester (server).';
    const CONFLICT = 'The page changed since this was prepared (server).';
    h.listChangeSets.mockResolvedValue([cs]);
    h.getChangeSetDiff.mockResolvedValue({ changeSet: cs, diff: [{ assetId: 'a1', label: 'Home page', fields: [{ field: 'hero.title', before: 'Spring sale', after: 'Summer sale' }] }] });
    h.requestApproval.mockResolvedValue({ changeSet: cs, approvalId: 'ap1' });
    h.approveChangeSet.mockRejectedValueOnce(new CampaignOpsError(FORBIDDEN, 403, 'separation-of-duties'))
      .mockRejectedValueOnce(new CampaignOpsError(CONFLICT, 409));
    render(<OperationsPage />);
    const review = await screen.findByRole('region', { name: /Waiting for review/ });
    await within(review).findByText('Field: hero.title');
    expect(review.querySelector('del')?.textContent).toBe('pring'); // the removed span
    expect(review.querySelector('ins')?.textContent).toBe('ummer'); // the added span
    fireEvent.click(within(review).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(h.approveChangeSet).toHaveBeenCalledWith('ap1', 'h-123'));
    await within(review).findAllByText(FORBIDDEN);
    expect(within(review).queryByText('You asked for this change, so someone else has to approve it.')).toBeNull();
    // The 409 half: the server's words, not the generic reload copy.
    const reviewAgain = await screen.findByRole('region', { name: /Waiting for review/ });
    await waitFor(() => expect((within(reviewAgain).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(reviewAgain).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(h.approveChangeSet).toHaveBeenCalledTimes(2));
    await within(reviewAgain).findAllByText(CONFLICT);
    expect(within(reviewAgain).queryByText('This change moved on since you opened it. The list has been refreshed.')).toBeNull();
  });

  it('a job needing attention lists each page with its reason in plain words', async () => {
    h.listJobs.mockResolvedValue([{ jobId: 'j1', changeSetId: 'cs1', approvalId: 'ap1', status: 'needs_attention', steps: [{ assetId: 'a1', label: 'Home page', state: 'conflicted', reason: 'newer_human_edit', attempts: 1 }] }]);
    render(<OperationsPage />);
    const col = await screen.findByRole('region', { name: /Needs attention/ });
    expect(await within(col).findByText('Someone edited this after it was prepared')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('splitChange isolates the changed span', () => {
    expect(splitChange('Spring sale now', 'Summer sale now')).toEqual({ prefix: 'S', removed: 'pring', added: 'ummer', suffix: ' sale now' });
    expect(splitChange('', 'New')).toEqual({ prefix: '', removed: '', added: 'New', suffix: '' });
    // Overlap: the prefix scan claims both 'a's (start=2), so the suffix scan
    // may claim nothing (end < max - start = 0). Worked by hand, not computed.
    expect(splitChange('aa', 'aaa')).toEqual({ prefix: 'aa', removed: '', added: 'a', suffix: '' });
    // start=3 ('abc'), max=3 → end bound 0: the tail 'abc' is removed, not shared.
    expect(splitChange('abcabc', 'abc')).toEqual({ prefix: 'abc', removed: 'abc', added: '', suffix: '' });
  });
  it('stepReasonKey maps unknown reasons to a plain fallback', () => {
    expect(stepReasonKey('preview_only')).toBe('reason_preview_only');
    expect(stepReasonKey('creative_blocked')).toBe('reason_creative_blocked'); // ADR 0945 D5
    expect(stepReasonKey('weird_code')).toBe('reason_other');
    expect(stepReasonKey(undefined)).toBeNull();
  });

  describe('ADR 0924 D5 — client approval', () => {
    it('hides the approvers panel while the portal is off', async () => {
      h.listClients.mockResolvedValue({ clients: [client('live')], agencyAdmin: true });
      render(<OperationsPage />);
      await screen.findByRole('button', { name: 'Switch back to preview' });
      await waitFor(() => expect(h.listApprovers).toHaveBeenCalledWith('o1'));
      expect(screen.queryByText('Client approvers')).toBeNull();
    });

    it('an admin adds an approver when the portal is on', async () => {
      h.listClients.mockResolvedValue({ clients: [client('live')], agencyAdmin: true });
      h.listApprovers.mockResolvedValue({ approvers: [], portalEnabled: true });
      h.addApprover.mockResolvedValue({ approverId: 'ap', orgId: 'o1', email: 'ann@client.test', displayName: 'Ann', status: 'active', createdAt: '' });
      render(<OperationsPage />);
      expect(await screen.findByText('Client approvers')).toBeTruthy();
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Ann' } });
      fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ann@client.test' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add approver' }));
      await waitFor(() => expect(h.addApprover).toHaveBeenCalledWith('o1', { displayName: 'Ann', email: 'ann@client.test' }));
    });

    it('under client approval an in-review change is sent to the client, never approved by the agency', async () => {
      h.listClients.mockResolvedValue({ clients: [{ ...client('live'), approvalPolicy: 'client' }], agencyAdmin: false });
      h.listChangeSets.mockResolvedValue([cs]);
      h.getChangeSetDiff.mockResolvedValue({ changeSet: cs, diff: [] });
      h.sendApprovalLinks.mockResolvedValue([{ approverId: 'ap', displayName: 'Ann', email: 'ann@client.test', url: 'https://app.test/shared/abc' }]);
      render(<OperationsPage />);
      const review = await screen.findByRole('region', { name: /Waiting for review/ });
      const sendBtn = await within(review).findByRole('button', { name: 'Send to client' });
      expect(within(review).queryByRole('button', { name: 'Approve' })).toBeNull();
      fireEvent.click(sendBtn);
      await waitFor(() => expect(h.sendApprovalLinks).toHaveBeenCalledWith('o1', 'cs1'));
      expect(((await within(review).findByLabelText('Link for Ann')) as HTMLInputElement).value).toBe('https://app.test/shared/abc');
      expect(h.approveChangeSet).not.toHaveBeenCalled();
    });
  });
});
