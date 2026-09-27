/**
 * CMNT-UX-2 / CMNT-UX-3 — the PANEL's own failed-read honesty and write feedback.
 *
 * The panel was STUBBED OUT of both files that fixed this class one level up
 * (`commentsFailedReads.test.tsx:51-53`, `orgsFailedGuard.test.tsx:53-54`), which
 * is exactly why its copy of the shape survived: a rejected thread read did
 * `setComments([]); setError(…)`, rendering an unannounced error Notice AND the
 * "No comments yet — Be the first to leave a note" card, with the composer live.
 * On all four mount sites. Here it is tested UNSTUBBED, with BOTH arms
 * everywhere — a one-armed suite lets the fix rot into "always show the error".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({ listThread: vi.fn(), postComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn() }));
vi.mock('../commentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../commentsClient.js')>();
  return { ...orig, ...api };
});
// ADR 0659 D7 (`CMNT-UX-20`) — the panel resolves the caller's org-scoped write
// access. Mocked here so these cases stay about the read/write lanes they are
// named for: the default is a member who CAN write, which is what the
// assertions below assume. `commentsPanelAccess.test.tsx` drives the other arms.
const orgAccess = vi.hoisted(() => ({ value: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' } as unknown }));
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, useOrgEffectiveAccess: () => orgAccess.value };
});

vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

// The toast renders in a portal outside the RTL container, so assert the CALL.
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));

const members = vi.hoisted(() => ({ loadOrgMembers: vi.fn() }));
vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers: members.loadOrgMembers, invalidateOrgMembers: vi.fn() }));

import { CommentsPanel } from '../CommentsPanel.js';
import { CommentsHttpError } from '../commentsClient.js';
import { currentAnnouncements } from '../../../ui/announce.js';

const comment = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  commentId: id, orgId: 'org_1', resourceType: 'cms_page', resourceId: 'p1',
  body, authorId: 'user_a', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function view(): void {
  render(<CommentsPanel orgId="org_1" resourceType="cms_page" resourceId="p1" />);
}

beforeEach(() => { vi.clearAllMocks(); members.loadOrgMembers.mockResolvedValue([]); });
afterEach(cleanup);

describe('CMNT-UX-2 — a failed thread read never claims the thread is empty', () => {
  it('FAILURE: says the read failed, offers Retry, and does NOT say "No comments yet"', async () => {
    api.listThread.mockRejectedValue(new Error('thread_500'));
    view();
    expect(await screen.findByText(/we can’t say what’s in it/i)).toBeTruthy();
    expect(screen.queryByText(/No comments yet/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('EMPTY: a genuinely empty thread still says "No comments yet"', async () => {
    api.listThread.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No comments yet/i)).toBeTruthy();
    expect(screen.queryByText(/we can’t say what’s in it/i)).toBeNull();
  });

  it('FAILURE: the composer is disabled with a named reason (no posting into an unseen thread)', async () => {
    api.listThread.mockRejectedValue(new Error('thread_500'));
    view();
    await screen.findByText(/we can’t say what’s in it/i);
    expect((screen.getByLabelText(/New comment/i) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/Commenting is paused until the thread loads/i)).toBeTruthy();
  });

  it('EMPTY: the composer stays ENABLED — the fix must not disable it for everyone', async () => {
    api.listThread.mockResolvedValue([]);
    view();
    await screen.findByText(/No comments yet/i);
    expect((screen.getByLabelText(/New comment/i) as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('FAILURE: the failure state ANNOUNCES (a silent swap from an aria-hidden skeleton told nobody)', async () => {
    api.listThread.mockRejectedValue(new Error('thread_500'));
    view();
    await screen.findByText(/we can’t say what’s in it/i);
    await waitFor(() => expect(currentAnnouncements().polite).toMatch(/Could not load this/i));
  });

  it('RETRY: a successful retry replaces the failure with the real thread', async () => {
    api.listThread.mockRejectedValueOnce(new Error('thread_500')).mockResolvedValue([comment('c1', 'hello')]);
    view();
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.queryByText(/we can’t say what’s in it/i)).toBeNull();
  });
});

describe('CMNT-UX-3 — a write does not unmount the thread, and it announces', () => {
  it('POST: the composer survives the refresh and the outcome is announced', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'existing')]);
    api.postComment.mockResolvedValue(comment('c2', 'new one'));
    view();
    await screen.findByText('existing');

    fireEvent.change(screen.getByLabelText(/New comment/i), { target: { value: 'new one' } });
    fireEvent.click(screen.getByRole('button', { name: /^Comment$/i }));

    await waitFor(() => expect(api.postComment).toHaveBeenCalled());
    // The list is HELD during the refresh — before the fix `comments` went
    // `null` and the entire panel, composer included, became an aria-hidden
    // skeleton, so focus fell to <body> and nothing was announced.
    expect(screen.getByText('existing')).toBeTruthy();
    expect(screen.getByLabelText(/New comment/i)).toBeTruthy();
    await waitFor(() => expect(currentAnnouncements().polite).toMatch(/Comment posted/i));
  });

  it('RESOLVE: announces, and busy is PER-ROW (a sibling row stays operable)', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'first'), comment('c2', 'second')]);
    let release: (v: unknown) => void = () => {};
    api.updateComment.mockImplementation(() => new Promise((res) => { release = res; }));
    view();
    await screen.findByText('first');

    const resolveButtons = screen.getAllByRole('button', { name: /Resolve/i });
    expect(resolveButtons.length).toBe(2);
    fireEvent.click(resolveButtons[0]!);

    // The OTHER row's Resolve must stay operable while the first is in flight.
    //
    // CMNT-UX-16 — the busy row is now `aria-disabled` + `.is-disabled`, NOT
    // natively `disabled`: a native `disabled` blurs the focused control to
    // `<body>` the instant the write starts, which is the defect this row
    // reopened. `disabled` staying FALSE on the busy button is therefore part of
    // the assertion, not an omission from it.
    await waitFor(() => expect(resolveButtons[0]!.getAttribute('aria-disabled')).toBe('true'));
    expect((resolveButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect(resolveButtons[1]!.getAttribute('aria-disabled')).toBeNull();
    expect((resolveButtons[1] as HTMLButtonElement).disabled).toBe(false);

    release(comment('c1', 'first', { status: 'resolved' }));
    await waitFor(() => expect(currentAnnouncements().polite).toMatch(/Marked resolved/i));
  });

  it('DELETE: announces the outcome', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'doomed')]);
    api.deleteComment.mockResolvedValue(undefined);
    view();
    await screen.findByText('doomed');
    fireEvent.click(screen.getByRole('button', { name: /Delete comment/i }));
    await waitFor(() => expect(currentAnnouncements().polite).toMatch(/Comment deleted/i));
  });

  it('a FAILED write still surfaces as an error and never announces success', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'existing')]);
    api.postComment.mockRejectedValue(new Error('post_500'));
    view();
    await screen.findByText('existing');
    fireEvent.change(screen.getByLabelText(/New comment/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^Comment$/i }));
    await waitFor(() => expect(api.postComment).toHaveBeenCalled());
    expect(currentAnnouncements().polite).not.toMatch(/Comment posted/i);
    expect(toasts.error).toHaveBeenCalled(); // and it DID surface as an error
  });
});

describe('CMNT-UX-5 — authors are people, not raw subject ids', () => {
  it('renders the member’s display name for a human author', async () => {
    members.loadOrgMembers.mockResolvedValue([{ memberId: 'm1', subject: 'user_a', displayName: 'Ada Lovelace', roles: ['editor'] }]);
    api.listThread.mockResolvedValue([comment('c1', 'hello')]);
    view();
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.queryByText('user_a')).toBeNull();
  });

  it('FAILURE: a failed directory read SAYS names may be missing rather than passing ids off as names', async () => {
    members.loadOrgMembers.mockRejectedValue(new Error('members_500'));
    api.listThread.mockResolvedValue([comment('c1', 'hello')]);
    view();
    expect(await screen.findByText(/authors below are shown by id/i)).toBeTruthy();
    expect(screen.getByText('user_a')).toBeTruthy(); // the id is still shown, just labelled honestly
  });

  it('CONTROL: a successful read shows NO fallback notice', async () => {
    members.loadOrgMembers.mockResolvedValue([{ memberId: 'm1', subject: 'user_a', displayName: 'Ada Lovelace', roles: ['editor'] }]);
    api.listThread.mockResolvedValue([comment('c1', 'hello')]);
    view();
    await screen.findByText('Ada Lovelace');
    expect(screen.queryByText(/authors below are shown by id/i)).toBeNull();
  });

  it('an agent author keeps its friendly label and is never looked up', async () => {
    members.loadOrgMembers.mockResolvedValue([]);
    api.listThread.mockResolvedValue([comment('c1', 'auto', { authorId: 'agent:run-7' })]);
    view();
    expect(await screen.findByText('Agent')).toBeTruthy();
    expect(screen.queryByText('agent:run-7')).toBeNull();
  });
});

describe('CMNT-UX-8 — the 4000-char cap is visible, not silent', () => {
  it('the composer carries maxLength so the server never truncates unannounced', async () => {
    api.listThread.mockResolvedValue([]);
    view();
    await screen.findByText(/No comments yet/i);
    expect((screen.getByLabelText(/New comment/i) as HTMLTextAreaElement).maxLength).toBe(4000);
  });

  it('a counter appears only as the cap approaches', async () => {
    api.listThread.mockResolvedValue([]);
    view();
    await screen.findByText(/No comments yet/i);
    const box = screen.getByLabelText(/New comment/i);
    fireEvent.change(box, { target: { value: 'x'.repeat(10) } });
    expect(screen.queryByText(/characters/i)).toBeNull();
    fireEvent.change(box, { target: { value: 'x'.repeat(3900) } });
    expect(screen.getByText(/3900 \/ 4000 characters/i)).toBeTruthy();
  });
});

describe('CMNT-UX-9 — a delete refusal says which refusal it is', () => {
  it('403 names the authority rule and offers resolve as the alternative', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'not mine')]);
    api.deleteComment.mockRejectedValue(new CommentsHttpError('Only the author or an org admin may delete a comment.', 403));
    view();
    await screen.findByText('not mine');
    fireEvent.click(screen.getByRole('button', { name: /Delete comment/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/only its author or an organization admin can/i)));
  });

  it('409 names the DIFFERENT rule (foreign replies), not the 403 one', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'has replies')]);
    api.deleteComment.mockRejectedValue(new CommentsHttpError('conflict', 409));
    view();
    await screen.findByText('has replies');
    fireEvent.click(screen.getByRole('button', { name: /Delete comment/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/Other people have replied/i)));
    expect(toasts.error).not.toHaveBeenCalledWith(expect.stringMatching(/only its author or an organization admin can/i));
  });
});

describe('CMNT-UX-8 — BOTH composers cap the body, not just the root one', () => {
  /**
   * ENUMERATE THE CLASS. The first pass gave the ROOT composer `maxLength` and a
   * counter and stopped there. The REPLY textarea feeds the same `add()` →
   * `postComment` → `cleanString(body, MAX.body)` path, which truncates at 4,000
   * and still returns 201 — so a 5,000-character reply was accepted and silently
   * lost 1,000 characters on the refetch, which is verbatim the defect the fix
   * claimed to close, on the sibling control.
   */
  const BODY_MAX = 4000;

  it('the REPLY textarea carries the same cap as the root composer', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'a root comment')]);
    view();
    // Open the reply box on the root comment.
    fireEvent.click(await screen.findByRole('button', { name: /^reply$/i }));

    const reply = await screen.findByLabelText(/reply/i);
    expect((reply as HTMLTextAreaElement).maxLength).toBe(BODY_MAX);

    // And the ROOT composer still has it — this must not become an either/or.
    const root = screen.getByLabelText(/new comment|add a comment/i);
    expect((root as HTMLTextAreaElement).maxLength).toBe(BODY_MAX);
  });

  it('the reply counter appears as the cap approaches, and not before', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'a root comment')]);
    view();
    fireEvent.click(await screen.findByRole('button', { name: /^reply$/i }));
    const reply = await screen.findByLabelText(/reply/i);

    // Well short of the cap: no counter (a permanent one on a 2-row box is noise).
    fireEvent.change(reply, { target: { value: 'x'.repeat(10) } });
    expect(screen.queryByText(/10 \/ 4000/)).toBeNull();

    // Past the 80% threshold: the counter is shown, with the real numbers.
    const near = BODY_MAX - 100;
    fireEvent.change(reply, { target: { value: 'x'.repeat(near) } });
    expect(await screen.findByText(new RegExp(`${near}\\s*/\\s*${BODY_MAX}`))).toBeTruthy();
  });
});
