/**
 * ADR 0854 D1 — "Ask someone else to decide".
 *   - a received handoff's note is shown;
 *   - a decider can hand it off (person + required intent); the note then shows;
 *   - the server's "not an approver" (422) is said plainly; no button when the
 *     viewer cannot decide;
 *   - a failed people-load is said (not shown as nobody to pick) and Cancel + reopen retries.
 *
 * Sabotages that turn it red (probed w28): the note read dropped; the handoff not
 * kept after send; send enabled without an intent; blank lines sent; the 422
 * mapped to the generic error; the button shown to a non-decider; the people
 * failure swallowed or never reset on close.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import type { getReviewHandoff, handOffReview, ReviewHandoff as Handoff } from '../reviewHandoffClient.js';
import type { loadOrgMembers } from '../../../orgs/orgMembers.js';
import type { OrgMember } from '../../../client/accessClient.js';

const h = vi.hoisted(() => ({ get: vi.fn<typeof getReviewHandoff>(), post: vi.fn<typeof handOffReview>() }));
vi.mock('../reviewHandoffClient.js', () => ({ getReviewHandoff: h.get, handOffReview: h.post }));
const members = vi.hoisted(() => ({ load: vi.fn<typeof loadOrgMembers>() }));
vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers: members.load }));

import { ReviewHandoff } from '../ReviewHandoff.js';
import { ReviewRequestError } from '../reviewClient.js';

const BOB: OrgMember = { memberId: 'm1', orgId: 'o1', tenantId: 't1', subject: 'user-bob', displayName: 'Bob', roles: ['editor'], teamIds: [], createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' };
const HANDOFF: Handoff = { reviewId: 'r1', to: 'user-bob', by: 'user-al', at: '', note: { v: 1, intent: 'Legal sign-off on EU copy', decisions: [], openQuestions: ['GDPR line final?'], tried: [], producedBy: 'human' } };

beforeEach(() => { h.get.mockReset(); h.post.mockReset(); h.get.mockResolvedValue(null); members.load.mockReset(); members.load.mockResolvedValue([BOB]); });
afterEach(cleanup);

describe('ReviewHandoff', () => {
  it("shows a received handoff's note", async () => {
    h.get.mockResolvedValue(HANDOFF);
    render(<ReviewHandoff reviewId="r1" canHandOff={false} />);
    expect(await screen.findByText('Legal sign-off on EU copy')).toBeTruthy();
    expect(screen.getByText('GDPR line final?')).toBeTruthy();
  });

  it('a decider hands it off with a required intent; the note then shows', async () => {
    h.post.mockResolvedValue(HANDOFF);
    render(<ReviewHandoff reviewId="r1" canHandOff />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask someone else to decide' }));
    const send = screen.getByRole('button', { name: 'Hand off' }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bob' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Hand to'), { target: { value: 'user-bob' } });
    expect(send.disabled).toBe(true); // no intent yet
    fireEvent.change(screen.getByLabelText('What they need to know (required)'), { target: { value: 'Legal sign-off on EU copy' } });
    fireEvent.change(screen.getByLabelText('Still open (one per line)'), { target: { value: 'GDPR line final?\n\n' } });
    fireEvent.click(send);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('r1', 'user-bob', { intent: 'Legal sign-off on EU copy', openQuestions: ['GDPR line final?'] }));
    expect(await screen.findByText('Legal sign-off on EU copy')).toBeTruthy();
  });

  it('says plainly when the person is not an approver; no button for a non-decider', async () => {
    h.post.mockRejectedValue(new ReviewRequestError('validation_error: That person is not an approver for this request.', 'validation_error', 422));
    render(<ReviewHandoff reviewId="r1" canHandOff />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask someone else to decide' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bob' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Hand to'), { target: { value: 'user-bob' } });
    fireEvent.change(screen.getByLabelText('What they need to know (required)'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand off' }));
    expect((await screen.findAllByText("That person isn't an approver for this request.")).length).toBeGreaterThan(0);
    cleanup();
    h.get.mockClear();
    render(<ReviewHandoff reviewId="r1" canHandOff={false} />);
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('r1')); // THIS mount's load, not the first one's
    expect(screen.queryByRole('button', { name: 'Ask someone else to decide' })).toBeNull();
  });

  it('a failed people-load is said, not shown as nobody to pick; Cancel and reopen retries', async () => {
    members.load.mockRejectedValueOnce(new Error('503'));
    render(<ReviewHandoff reviewId="r1" canHandOff />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask someone else to decide' }));
    expect(await screen.findByText(/Couldn't load the people in this workspace/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask someone else to decide' }));
    expect(await screen.findByRole('option', { name: 'Bob' })).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the people/)).toBeNull();
    expect(members.load).toHaveBeenCalledTimes(2);
  });
});
