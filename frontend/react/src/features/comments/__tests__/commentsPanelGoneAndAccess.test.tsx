/**
 * ADR 0659 D2 + D7 — the panel's THIRD read outcome, its focus contract, its
 * typed refusals, its permission gate, and its one polite slot.
 *
 * Each describe below is a witness for a row that was OPEN at `d7bdabf9f`:
 *
 *  - `CMNT-UX-19` (Blocker) a target that does not RESOLVE — deleted, or a
 *    subject-bound collection the caller is not bound to — used to answer
 *    `200 {comments:[]}` and render "Be the first to leave a note on this
 *    resource" with a LIVE composer. D1 makes it a uniform 404; this file pins
 *    that the panel renders ONE gone-state with NO composer, for ALL SIX
 *    commentable types (the four picker-less ones are precisely what the
 *    notification emitter deep-links, and they had no hedge anywhere).
 *  - `CMNT-UX-16` a write must not take the control out from under the user.
 *    The assertions are on the MECHANISM (`disabled` stays false, `aria-busy` /
 *    `aria-disabled` carry the state) rather than on `document.activeElement`
 *    alone, because jsdom does not implement the blur-on-disabled behaviour the
 *    defect depended on — an activeElement-only test would pass against the
 *    BROKEN code and pin nothing.
 *  - `CMNT-UX-18` no backend prose in a toast, on any lane.
 *  - `CMNT-UX-20` a read-only member is not offered writes.
 *  - `CMNT-UX-22` `namesFailed` and `failed` can no longer both announce.
 *
 * All four mount sites (`/comments`, chat, the document toolbar, the document
 * Modal) construct `<CommentsPanel orgId resourceType resourceId />` with those
 * three props and nothing else, so the panel IS the mount site for every state
 * below; `commentsDeepLink.test.tsx` and `chat/__tests__/MessageComments.test.tsx`
 * cover the wiring into two of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent, act } from '@testing-library/react';

const api = vi.hoisted(() => ({ listThread: vi.fn(), postComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn() }));
vi.mock('../commentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../commentsClient.js')>();
  return { ...orig, ...api };
});
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

// The toast renders in a portal outside the RTL container, so assert the CALL.
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));

const members = vi.hoisted(() => ({ loadOrgMembers: vi.fn() }));
vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers: members.loadOrgMembers, invalidateOrgMembers: vi.fn() }));

const WRITER = { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' };
const VIEWER = { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' };
const orgAccess = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, useOrgEffectiveAccess: () => orgAccess.value };
});

import { CommentsPanel } from '../CommentsPanel.js';
import { CommentsHttpError, ALL_RESOURCE_TYPES, type ResourceType } from '../commentsClient.js';
import { currentAnnouncements } from '../../../ui/announce.js';

const comment = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  commentId: id, orgId: 'org_1', resourceType: 'cms_page', resourceId: 'p1',
  body, authorId: 'user_a', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function view(rt: ResourceType = 'cms_page'): void {
  render(<CommentsPanel orgId="org_1" resourceType={rt} resourceId="p1" />);
}

/** A promise whose settlement this test controls, so an in-flight window is
 *  observable rather than raced. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  members.loadOrgMembers.mockResolvedValue([]);
  orgAccess.value = WRITER;
});
afterEach(cleanup);

describe('CMNT-UX-19 (Blocker) — a thread cannot invite a note onto a target that is gone', () => {
  it.each(ALL_RESOURCE_TYPES)('404 on %s renders the gone-state and NO composer', async (rt) => {
    api.listThread.mockRejectedValue(new CommentsHttpError('Resource not found in this organization.', 404, 'not_found'));
    view(rt);

    expect(await screen.findByText(/isn’t available to you/i)).toBeTruthy();
    // The false-empty this row exists to close.
    expect(screen.queryByText(/No comments yet/i)).toBeNull();
    expect(screen.queryByText(/Be the first to leave a note/i)).toBeNull();
    // And the composer is not merely disabled — it is not RENDERED. A disabled
    // box still reads as "you could write here", which is the invitation.
    expect(screen.queryByLabelText(/New comment/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Comment$/i })).toBeNull();
  });

  it('403 lands in the SAME state — the client must not split "deleted" from "not visible"', async () => {
    api.listThread.mockRejectedValue(new CommentsHttpError('Forbidden.', 403, 'forbidden'));
    view();
    expect(await screen.findByText(/isn’t available to you/i)).toBeTruthy();
    expect(screen.queryByLabelText(/New comment/i)).toBeNull();
  });

  it('the copy names NEITHER cause — it may have been deleted, or you may not have access', async () => {
    api.listThread.mockRejectedValue(new CommentsHttpError('Resource not found in this organization.', 404, 'not_found'));
    view();
    const body = await screen.findByText(/isn’t available to you/i);
    expect(body.textContent).toMatch(/deleted/i);
    expect(body.textContent).toMatch(/access/i);
    // Never the backend's own sentence.
    expect(document.body.textContent).not.toMatch(/Resource not found in this organization/);
  });

  it('CONTROL: a genuinely EMPTY 200 still invites the first comment', async () => {
    api.listThread.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No comments yet/i)).toBeTruthy();
    expect(screen.getByLabelText(/New comment/i)).toBeTruthy();
    expect(screen.queryByText(/isn’t available to you/i)).toBeNull();
  });

  it('CONTROL: a TRANSPORT failure is still the failed-read state, not the gone-state', async () => {
    api.listThread.mockRejectedValue(new Error('network'));
    view();
    expect(await screen.findByText(/we can’t say what’s in it/i)).toBeTruthy();
    expect(screen.queryByText(/isn’t available to you/i)).toBeNull();
  });

  it('a post that comes back 404 re-resolves the panel into the gone-state', async () => {
    api.listThread.mockResolvedValueOnce([comment('c1', 'stale')])
      .mockRejectedValue(new CommentsHttpError('Resource not found in this organization.', 404, 'not_found'));
    api.postComment.mockRejectedValue(new CommentsHttpError('Resource not found in this organization.', 404, 'not_found'));
    view();
    await screen.findByText('stale');
    fireEvent.change(screen.getByLabelText(/New comment/i), { target: { value: 'into the void' } });
    fireEvent.click(screen.getByRole('button', { name: /^Comment$/i }));
    expect(await screen.findByText(/isn’t available to you/i)).toBeTruthy();
    expect(screen.queryByLabelText(/New comment/i)).toBeNull();
  });
});

describe('CMNT-UX-16 — a write does not take the control out from under the user', () => {
  it('POST: the Comment button is never natively disabled, so focus is never blurred', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'existing')]);
    const post = deferred<unknown>();
    api.postComment.mockReturnValue(post.promise);
    view();
    await screen.findByText('existing');

    fireEvent.change(screen.getByLabelText(/New comment/i), { target: { value: 'hello' } });
    const btn = screen.getByRole('button', { name: /^Comment$/i }) as HTMLButtonElement;
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);

    // IN FLIGHT: busy is announced by `aria-busy`, never by removing the control
    // from the tab order — `disabled` is what browsers blur.
    await waitFor(() => expect(btn.getAttribute('aria-busy')).toBe('true'));
    expect(btn.disabled).toBe(false);
    expect(document.activeElement).toBe(btn);

    await act(async () => { post.resolve(comment('c2', 'hello')); await post.promise; });

    // AFTER: the draft was cleared, so the button is unavailable again — and it
    // is STILL the same focusable node, which is the whole row.
    await waitFor(() => expect(btn.getAttribute('aria-disabled')).toBe('true'));
    expect(btn.disabled).toBe(false);
    expect(document.contains(btn)).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it('POST: a repeat activation while in flight is IGNORED (the guard the disable used to be)', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'existing')]);
    const post = deferred<unknown>();
    api.postComment.mockReturnValue(post.promise);
    view();
    await screen.findByText('existing');

    fireEvent.change(screen.getByLabelText(/New comment/i), { target: { value: 'hello' } });
    const btn = screen.getByRole('button', { name: /^Comment$/i });
    fireEvent.click(btn);
    await waitFor(() => expect(api.postComment).toHaveBeenCalledTimes(1));
    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => { post.resolve(comment('c2', 'hello')); await post.promise; });
    expect(api.postComment).toHaveBeenCalledTimes(1);
  });

  it('RETRY: the button keeps its NODE (and focus) while the reload runs', async () => {
    api.listThread.mockRejectedValueOnce(new Error('thread_500'));
    view();
    const retry = await screen.findByRole('button', { name: /retry/i });
    retry.focus();
    expect(document.activeElement).toBe(retry);

    const second = deferred<unknown[]>();
    api.listThread.mockReturnValue(second.promise);
    fireEvent.click(retry);

    // Before the fix this called `load()` with no `keepList`, which nulled
    // `comments` and replaced the ENTIRE panel — Retry included — with
    // `SkeletonRows`, so the node under the user's finger was gone.
    await waitFor(() => expect(retry.getAttribute('aria-busy')).toBe('true'));
    expect(document.contains(retry)).toBe(true);
    expect(document.activeElement).toBe(retry);
    expect((retry as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { second.resolve([comment('c1', 'recovered')]); await second.promise; });
    expect(await screen.findByText('recovered')).toBeTruthy();
  });

  it('RETRY: the failure card stays on screen during the reload — no blank flash', async () => {
    api.listThread.mockRejectedValueOnce(new Error('thread_500'));
    view();
    const retry = await screen.findByRole('button', { name: /retry/i });
    const second = deferred<unknown[]>();
    api.listThread.mockReturnValue(second.promise);
    fireEvent.click(retry);
    await waitFor(() => expect(retry.getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByText(/we can’t say what’s in it/i)).toBeTruthy();
    await act(async () => { second.resolve([]); await second.promise; });
  });
});

describe('CMNT-UX-18 — a refusal in the reader’s language, on every lane', () => {
  const PROSE = [
    '`body` is required and MUST be a non-empty string.',
    'Only the author may edit a comment body.',
    'Resource not found in this organization.',
  ];
  const lastToast = (): string => String(toasts.error.mock.calls.at(-1)?.[0] ?? '');

  it('POST 400: localized copy, and NOT the backend sentence with its backticks and MUST', async () => {
    api.listThread.mockResolvedValue([]);
    api.postComment.mockRejectedValue(new CommentsHttpError(PROSE[0]!, 400, 'validation_error'));
    view();
    await screen.findByText(/No comments yet/i);
    fireEvent.change(screen.getByLabelText(/New comment/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^Comment$/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(lastToast()).toMatch(/couldn’t be saved/i);
    for (const p of PROSE) expect(lastToast()).not.toContain(p);
    expect(lastToast()).not.toMatch(/MUST/);
    expect(lastToast()).not.toContain('`');
  });

  it('PATCH 403: the author guard is named, not echoed', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'theirs')]);
    api.updateComment.mockRejectedValue(new CommentsHttpError(PROSE[1]!, 403, 'forbidden'));
    view();
    await screen.findByText('theirs');
    fireEvent.click(screen.getByRole('button', { name: /Resolve/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(lastToast()).toMatch(/only its author or an organization admin/i);
    expect(lastToast()).not.toContain(PROSE[1]!);
  });

  it('PATCH 403 forbidden_scope: says it is a PERMISSION problem, not an authorship one', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'theirs')]);
    api.updateComment.mockRejectedValue(new CommentsHttpError('Missing required scope: workspace:write', 403, 'forbidden_scope'));
    view();
    await screen.findByText('theirs');
    fireEvent.click(screen.getByRole('button', { name: /Resolve/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(lastToast()).toMatch(/read-only access/i);
    expect(lastToast()).not.toContain('workspace:write,');
    expect(lastToast()).not.toContain('Missing required scope');
  });

  it('DELETE keeps its two named refusals (403 vs 409 remain different advice)', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'doomed')]);
    api.deleteComment.mockRejectedValueOnce(new CommentsHttpError('nope', 409, 'conflict'));
    view();
    await screen.findByText('doomed');
    fireEvent.click(screen.getByRole('button', { name: /Delete comment/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(lastToast()).toMatch(/Other people have replied/i);
  });

  it('a NON-http failure falls back to a localized key, never `e.message`', async () => {
    api.listThread.mockResolvedValue([]);
    api.postComment.mockRejectedValue(new Error('TypeError: Failed to fetch'));
    view();
    await screen.findByText(/No comments yet/i);
    fireEvent.change(screen.getByLabelText(/New comment/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^Comment$/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(lastToast()).toBe('Post failed.');
    expect(lastToast()).not.toContain('Failed to fetch');
  });
});

describe('CMNT-UX-20 — a read-only member is told, not refused', () => {
  it('VIEWER: no composer input, no Reply / Resolve / Delete, and a reason that says why', async () => {
    orgAccess.value = VIEWER;
    api.listThread.mockResolvedValue([comment('c1', 'a note')]);
    view();
    await screen.findByText('a note');

    expect((screen.getByLabelText(/New comment/i) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/read-only access to this workspace/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Resolve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete comment/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reply$/i })).toBeNull();
  });

  it('VIEWER: pressing the Comment button writes nothing (the gate is not decorative)', async () => {
    orgAccess.value = VIEWER;
    api.listThread.mockResolvedValue([]);
    view();
    await screen.findByText(/No comments yet/i);
    // Drive a value in directly rather than through the keyboard — otherwise an
    // empty draft alone would refuse the write and this case would pass with the
    // permission gate REMOVED, pinning nothing.
    fireEvent.change(screen.getByLabelText(/New comment/i), { target: { value: 'let me in' } });
    fireEvent.click(screen.getByRole('button', { name: /^Comment$/i }));
    await Promise.resolve();
    expect(api.postComment).not.toHaveBeenCalled();
  });

  it('WRITER: the same screen keeps every control (a deny-only fix would pass the first case alone)', async () => {
    orgAccess.value = WRITER;
    api.listThread.mockResolvedValue([comment('c1', 'a note')]);
    view();
    await screen.findByText('a note');
    expect((screen.getByLabelText(/New comment/i) as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByText(/read-only access to this workspace/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Resolve/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete comment/i })).toBeTruthy();
  });

  it('UNRESOLVED access claims NOTHING — the controls stay live rather than asserting read-only', async () => {
    // A failed or still-pending access read is not "you lack permission"; saying
    // so would be the §4.6 false-read shape. The backend remains the authority
    // and now refuses in the user's own language.
    orgAccess.value = null;
    api.listThread.mockResolvedValue([comment('c1', 'a note')]);
    view();
    await screen.findByText('a note');
    expect((screen.getByLabelText(/New comment/i) as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByText(/read-only access to this workspace/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Resolve/i })).toBeTruthy();
  });
});

describe('CMNT-UX-22 — one polite slot, so one announcement', () => {
  it('both reads fail: the THREAD failure is announced and the directory caveat is not rendered at all', async () => {
    members.loadOrgMembers.mockRejectedValue(new Error('members_500'));
    api.listThread.mockRejectedValue(new Error('thread_500'));
    view();
    await screen.findByText(/we can’t say what’s in it/i);
    // Suppressed by PREDICATE, not by JSX order — with no readable thread there
    // are no authors on screen to mislabel.
    expect(screen.queryByText(/member directory/i)).toBeNull();
    await waitFor(() => expect(currentAnnouncements().polite).toMatch(/Could not load this/i));
  });

  it('CONTROL: with a readable thread the directory caveat is still shown and announced', async () => {
    members.loadOrgMembers.mockRejectedValue(new Error('members_500'));
    api.listThread.mockResolvedValue([comment('c1', 'a note')]);
    view();
    await screen.findByText('a note');
    expect(await screen.findByText(/member directory/i)).toBeTruthy();
    await waitFor(() => expect(currentAnnouncements().polite).toMatch(/member directory/i));
  });
});

describe('CMNT-UX-21 — the reply index is keyed, and a keystroke does not re-render the thread', () => {
  it('replies land under their own parent (one pass, not a per-root re-scan)', async () => {
    api.listThread.mockResolvedValue([
      comment('r1', 'root one'),
      comment('r2', 'root two'),
      comment('a1', 'reply to one', { parentId: 'r1' }),
      comment('b1', 'reply to two', { parentId: 'r2' }),
      comment('a2', 'second reply to one', { parentId: 'r1' }),
    ]);
    view();
    const rootOne = (await screen.findByText('root one')).closest('.surface-inset')!.parentElement!;
    expect(rootOne.textContent).toContain('reply to one');
    expect(rootOne.textContent).toContain('second reply to one');
    expect(rootOne.textContent).not.toContain('reply to two');
  });

  it('an ORPHANED reply (its parent was deleted) renders nowhere — recorded, not silently mis-parented', async () => {
    api.listThread.mockResolvedValue([
      comment('r1', 'root one'),
      comment('orph', 'orphan body', { parentId: 'gone_parent' }),
    ]);
    view();
    await screen.findByText('root one');
    expect(screen.queryByText('orphan body')).toBeNull();
  });

  it('typing in the composer does not re-read or re-fetch the thread', async () => {
    api.listThread.mockResolvedValue([comment('c1', 'existing')]);
    view();
    await screen.findByText('existing');
    expect(api.listThread).toHaveBeenCalledTimes(1);
    const box = screen.getByLabelText(/New comment/i);
    for (const v of ['h', 'he', 'hel', 'hell', 'hello']) fireEvent.change(box, { target: { value: v } });
    expect(api.listThread).toHaveBeenCalledTimes(1);
    expect((box as HTMLTextAreaElement).value).toBe('hello');
    // The thread is still on screen and untouched by the keystrokes.
    expect(screen.getByText('existing')).toBeTruthy();
  });
});
