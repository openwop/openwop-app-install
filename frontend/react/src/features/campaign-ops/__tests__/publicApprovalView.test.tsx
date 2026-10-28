/**
 * ADR 0924 D5 — the client approver's page. It approves with the exact hash the
 * page was given, says when the change was updated (stale) or the link is dead,
 * and never offers a decision on a stale package.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ decideApproval: vi.fn() }));
vi.mock('../portalClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

import { PublicApprovalView } from '../PublicApprovalView.js';
import { PortalDecisionError } from '../portalClient.js';

const pkg = {
  kind: 'campaign_approval', state: 'in_review', clientName: 'Acme', approverName: 'Ann',
  request: 'Move the webinar to Thursday', changeSetHash: 'h-abc', maxComment: 2000,
  changes: [{ assetId: 'a1', label: 'Webinar page', fields: [{ field: 'heading', before: 'Tuesday, Nov 3', after: 'Thursday, Nov 5' }] }],
};

beforeEach(() => { h.decideApproval.mockReset(); });
afterEach(cleanup);

describe('PublicApprovalView', () => {
  it('shows the request and the change, and approves the hash it was shown, with the comment', async () => {
    h.decideApproval.mockResolvedValue('approved');
    render(<PublicApprovalView token="tok" resource={pkg} />);
    expect(screen.getByText('A change for Acme needs your approval')).toBeTruthy();
    expect(screen.getByText('Move the webinar to Thursday')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: ' Looks right ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve this change' }));
    await waitFor(() => expect(h.decideApproval).toHaveBeenCalledWith('tok', { action: 'approve', expectedChangeSetHash: 'h-abc', comment: 'Looks right' }));
    expect(await screen.findByText('Approved. Thank you.')).toBeTruthy();
  });

  it('a stale package says so and offers no decision', () => {
    render(<PublicApprovalView token="tok" resource={{ kind: 'campaign_approval', state: 'stale', clientName: 'Acme' }} />);
    expect(screen.getByText('This change was updated')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve this change' })).toBeNull();
  });

  it('a link that died meanwhile says it no longer works', async () => {
    h.decideApproval.mockRejectedValue(new PortalDecisionError('gone'));
    render(<PublicApprovalView token="tok" resource={pkg} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('This link no longer works')).toBeTruthy();
  });
});
