/**
 * ADR 0926 P0 — the Operations inbox.
 *
 *   - a preview client carries the "nothing is written" banner; a live one does not;
 *   - the mode switch shows only for an agency admin;
 *   - a duplicate submit offers "send anyway" and re-sends with the reason;
 *   - a change set in review approves with the change set's hash in the body, and
 *     a 403 / 409 shows the server's own words;
 *   - the change is shown before → after, with step reasons in plain words;
 *   - a failed clients read is said, never shown as "no clients".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  listClients: vi.fn(), updateClient: vi.fn(), listAssets: vi.fn(), listRequests: vi.fn(),
  submitRequest: vi.fn(), answerQuestions: vi.fn(), reviseRequest: vi.fn(), listChangeSets: vi.fn(),
  getChangeSetDiff: vi.fn(), requestApproval: vi.fn(), listJobs: vi.fn(), approveChangeSet: vi.fn(), rejectChangeSet: vi.fn(),
}));
vi.mock('../campaignOpsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

import { OperationsPage, stepReasonKey } from '../OperationsPage.js';
import { splitChange } from '../ChangeDiff.js';
import { CampaignOpsError } from '../campaignOpsClient.js';

const client = (mode: 'preview' | 'live') => ({ tenantId: 't', orgId: 'o1', displayName: 'Acme', status: 'active', mode, approvalPolicy: 'agency', createdAt: '', updatedAt: '' });
const cs = { changeSetId: 'cs1', requestId: 'r1', requestVersion: 1, entries: [], hash: 'h-123', status: 'in_review', createdAt: '' };

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.listClients.mockResolvedValue({ clients: [client('preview')], agencyAdmin: false });
  h.listAssets.mockResolvedValue([{ assetId: 'a1', orgId: 'o1', destination: 'openwop.cms.page', locator: { pageId: 'p' }, label: 'Home page', editableFields: [] }]);
  h.listRequests.mockResolvedValue([]);
  h.listChangeSets.mockResolvedValue([]);
  h.listJobs.mockResolvedValue([]);
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

  it('a failed clients read is said, not shown as no clients', async () => {
    h.listClients.mockRejectedValue(new CampaignOpsError('boom', 500));
    render(<OperationsPage />);
    expect(await screen.findByText("Couldn't load your clients")).toBeTruthy();
    expect(screen.queryByText('No clients yet')).toBeNull();
  });

  it('a duplicate submit offers send anyway, which re-sends with the reason', async () => {
    h.submitRequest.mockResolvedValueOnce({ request: {}, duplicate: true }).mockResolvedValueOnce({ request: {}, duplicate: false });
    render(<OperationsPage />);
    await screen.findByLabelText('Home page');
    fireEvent.change(screen.getByLabelText('Describe the change'), { target: { value: 'New headline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect((await screen.findAllByText('This looks like a request you already made')).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Why send it again?'), { target: { value: 'client asked twice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    await waitFor(() => expect(h.submitRequest).toHaveBeenLastCalledWith('o1', { text: 'New headline', assetIds: ['a1'], overrideDuplicate: { reason: 'client asked twice' } }));
  });

  it('approves a change in review with its hash and shows the diff; a 403 shows the server words', async () => {
    h.listChangeSets.mockResolvedValue([cs]);
    h.getChangeSetDiff.mockResolvedValue({ changeSet: cs, diff: [{ assetId: 'a1', label: 'Home page', fields: [{ field: 'hero.title', before: 'Spring sale', after: 'Summer sale' }] }] });
    h.requestApproval.mockResolvedValue({ changeSet: cs, approvalId: 'ap1' });
    h.approveChangeSet.mockRejectedValue(new CampaignOpsError('You asked for this change, so someone else has to approve it.', 403, 'separation-of-duties'));
    render(<OperationsPage />);
    const review = await screen.findByRole('region', { name: /Waiting for review/ });
    await within(review).findByText('Field: hero.title');
    expect(review.querySelector('del')?.textContent).toBe('pring'); // the removed span
    expect(review.querySelector('ins')?.textContent).toBe('ummer'); // the added span
    fireEvent.click(within(review).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(h.approveChangeSet).toHaveBeenCalledWith('ap1', 'h-123'));
    expect((await within(review).findAllByText('You asked for this change, so someone else has to approve it.')).length).toBeGreaterThan(0);
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
  });
  it('stepReasonKey maps unknown reasons to a plain fallback', () => {
    expect(stepReasonKey('preview_only')).toBe('reason_preview_only');
    expect(stepReasonKey('weird_code')).toBe('reason_other');
    expect(stepReasonKey(undefined)).toBeNull();
  });
});
