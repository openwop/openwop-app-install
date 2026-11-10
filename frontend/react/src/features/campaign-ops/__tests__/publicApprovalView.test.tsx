/**
 * ADR 0924 D5 — the client approver's page. It approves with the exact hash the
 * page was given, says when the change was updated (stale) or the link is dead,
 * and never offers a decision on a stale package.
 *
 * Runs through the real `portalClient`: the page is public and the token is the
 * only authority, so the exact request (`credentials: 'omit'`, no session) and the
 * 404/409/429 mapping are part of the claim. Sabotage: `credentials: 'include'`,
 * a wrong hash, an empty diff, or 404 mapped to `failed` each red a case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { t } from 'i18next';

import { PublicApprovalView } from '../PublicApprovalView.js';
import { config } from '../../../client/config.js';

const pkg = {
  kind: 'campaign_approval', state: 'in_review', clientName: 'Acme', approverName: 'Ann',
  request: 'Move the webinar to Thursday', changeSetHash: 'h-abc', maxComment: 2000,
  changes: [{ assetId: 'a1', label: 'Webinar page', fields: [{ field: 'heading', before: 'Tuesday, Nov 3', after: 'Thursday, Nov 5' }] }],
};

const fetchMock = vi.fn<typeof fetch>();
const answer = (status: number, body: unknown = {}): void => { fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })); };

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PublicApprovalView', () => {
  it('shows the request and the change, and approves the hash it was shown, with the comment', async () => {
    answer(200, { status: 'approved' });
    render(<PublicApprovalView token="tok" resource={pkg} />);
    expect(screen.getByText('A change for Acme needs your approval')).toBeTruthy();
    expect(screen.getByText('Move the webinar to Thursday')).toBeTruthy();
    expect(screen.getByText('Webinar page')).toBeTruthy();
    expect(screen.getAllByRole('definition').map((d) => d.textContent)).toEqual(['Tuesday, Nov 3', 'Thursday, Nov 5']);
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: ' Looks right ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve this change' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`${config.baseUrl}/host/openwop-app/public-campaign-approval/tok/decision`, {
      method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', expectedChangeSetHash: 'h-abc', comment: 'Looks right' }),
    });
    expect(await screen.findByText('Approved. Thank you.')).toBeTruthy();
  });

  it('a stale package says so and offers no decision', () => {
    render(<PublicApprovalView token="tok" resource={{ kind: 'campaign_approval', state: 'stale', clientName: 'Acme' }} />);
    expect(screen.getByText('This change was updated')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve this change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('a link that died meanwhile says it no longer works', async () => {
    answer(404);
    render(<PublicApprovalView token="tok" resource={pkg} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('This link no longer works')).toBeTruthy();
  });

  it('a change updated before the decision says so and takes the buttons away', async () => {
    answer(409);
    render(<PublicApprovalView token="tok" resource={pkg} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve this change' }));
    expect(await screen.findByText('This change was updated')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve this change' })).toBeNull();
  });

  it('a rate-limited decision keeps the page and says to wait', async () => {
    answer(429);
    render(<PublicApprovalView token="tok" resource={pkg} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve this change' }));
    expect((await screen.findAllByText(t('campaign-ops:portalRateLimited'))).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Approve this change' })).toBeTruthy();
    expect(screen.getByText('Move the webinar to Thursday')).toBeTruthy();
  });
});
