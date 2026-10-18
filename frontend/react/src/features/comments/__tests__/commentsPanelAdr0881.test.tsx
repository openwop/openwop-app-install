/**
 * ADR 0881 — the panel's round-2 affordances, driven off the server's `viewer`:
 *
 *  - D7 Edit is offered on the viewer's OWN comments only; Delete on own, or to a
 *    moderator; a non-moderator's own root that carries other people's replies offers
 *    no Delete (the server answers 409 there). `viewer: null` claims nothing.
 *  - D5 the mention picker sends member ids, and members the server could not notify
 *    are named back in a warning toast.
 *  - D6 "(edited)" and "Resolved by …" render from the row.
 *  - CM2UX-1 / CM2UX-8 Escape hands focus back to Edit; a refused mention gets its
 *    own copy.
 *
 * D7 is asserted PER ROW, not by counting buttons: with one own and one foreign
 * comment, an inverted "mine" moves Edit and Delete to the other row and the
 * counts still hold (/grade-tests w52 found that case-1 blind spot by probe).
 *
 * Sabotage-witnessed (/grade-tests w52): an inverted `mine`, an inverted
 * foreign-reply check, no moderator branch, a fail-closed `viewer: null`, an
 * edit that saves the old body, mentions not sent, the unnotified list dropped,
 * no "(edited)", the author as resolver, no refocus on Escape, and a missed
 * mentions refusal each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  readThread: vi.fn<typeof import('../commentsClient.js').readThread>(),
  postComment: vi.fn<typeof import('../commentsClient.js').postComment>(),
  updateComment: vi.fn<typeof import('../commentsClient.js').updateComment>(),
  deleteComment: vi.fn<typeof import('../commentsClient.js').deleteComment>(),
}));
vi.mock('../commentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../commentsClient.js')>();
  return { ...orig, ...api };
});
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));
const members = vi.hoisted(() => ({ loadOrgMembers: vi.fn<typeof import('../../../orgs/orgMembers.js').loadOrgMembers>() }));
vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers: members.loadOrgMembers, invalidateOrgMembers: vi.fn() }));
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const access: EffectiveAccess = { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' };
  return { ...orig, useOrgEffectiveAccess: (): EffectiveAccess => access };
});

import { CommentsPanel } from '../CommentsPanel.js';
import type { Comment, ThreadViewer } from '../commentsClient.js';
import type { EffectiveAccess, OrgMember } from '../../../client/accessClient.js';

const member = (subject: string, displayName: string): OrgMember => ({
  memberId: `m_${subject}`, orgId: 'org_1', tenantId: 't_1', subject, displayName, roles: ['editor'], teamIds: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
/** The row a comment body sits in (the body div's parent is the row). */
const rowOf = (body: string): HTMLElement => screen.getByText(body).parentElement!;

const row = (id: string, authorId: string, over: Partial<Comment> = {}): Comment => ({
  commentId: id, orgId: 'org_1', resourceType: 'cms_page', resourceId: 'p1', body: `body ${id}`, authorId,
  status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});
const ME: ThreadViewer = { userId: 'user_me', canWrite: true, canModerate: false };

function view(): void { render(<CommentsPanel orgId="org_1" resourceType="cms_page" resourceId="p1" />); }

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  for (const f of Object.values(toasts)) f.mockReset();
  members.loadOrgMembers.mockReset();
  members.loadOrgMembers.mockResolvedValue([member('user_me', 'Me'), member('user_dana', 'Dana'), member('user_lee', 'Lee')]);
});
afterEach(cleanup);

describe('D7 — only what the server will do', () => {
  it('Edit on my own comment only; no Delete on someone else’s for a non-moderator', async () => {
    api.readThread.mockResolvedValue({ comments: [row('c1', 'user_me'), row('c2', 'user_dana')], viewer: ME });
    view();
    await screen.findByText('body c2');
    // Mine (c1): Edit + Delete. Dana's (c2): neither.
    expect(within(rowOf('body c1')).getByRole('button', { name: /^edit$/i })).toBeTruthy();
    expect(within(rowOf('body c1')).getByRole('button', { name: /delete comment/i })).toBeTruthy();
    expect(within(rowOf('body c2')).queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(within(rowOf('body c2')).queryByRole('button', { name: /delete comment/i })).toBeNull();
  });

  it('my own root with someone else’s reply offers no Delete (409); a moderator gets every Delete', async () => {
    api.readThread.mockResolvedValue({ comments: [row('c1', 'user_me'), row('r1', 'user_dana', { parentId: 'c1' })], viewer: ME });
    view();
    await screen.findByText('body r1');
    expect(screen.queryAllByRole('button', { name: /delete comment/i })).toHaveLength(0);
    cleanup();
    api.readThread.mockResolvedValue({ comments: [row('c1', 'user_me'), row('r1', 'user_dana', { parentId: 'c1' })], viewer: { ...ME, canModerate: true } });
    view();
    await screen.findByText('body r1');
    expect(screen.getAllByRole('button', { name: /delete comment/i })).toHaveLength(2);
  });

  it('viewer null (an older host) claims nothing: no Edit, Delete left to the server', async () => {
    api.readThread.mockResolvedValue({ comments: [row('c1', 'user_me')], viewer: null });
    view();
    await screen.findByText('body c1');
    expect(screen.queryAllByRole('button', { name: /^edit$/i })).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: /delete comment/i })).toHaveLength(1);
  });

  it('saves an edit through updateComment with the new body', async () => {
    api.readThread.mockResolvedValue({ comments: [row('c1', 'user_me')], viewer: ME });
    api.updateComment.mockResolvedValue(row('c1', 'user_me', { body: 'fixed' }));
    view();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    const box = screen.getByRole('textbox', { name: /edit comment/i });
    fireEvent.change(box, { target: { value: 'fixed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.updateComment).toHaveBeenCalledWith('org_1', 'c1', { body: 'fixed' }));
  });
});

describe('D5 — mentions', () => {
  it('posts the picked member ids and names anyone the server could not notify, in a Notice', async () => {
    api.readThread.mockResolvedValue({ comments: [], viewer: ME });
    api.postComment.mockResolvedValue({ ...row('c9', 'user_me'), unnotifiedMentions: ['user_lee'] });
    view();
    const box = await screen.findByRole('textbox', { name: /new comment/i });
    fireEvent.change(box, { target: { value: 'have a look' } });
    fireEvent.click(screen.getAllByRole('button', { name: /mention/i })[0]!);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Dana' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lee' }));
    fireEvent.click(screen.getByRole('button', { name: /^comment$/i }));
    await waitFor(() => expect(api.postComment).toHaveBeenCalledWith('org_1', {
      resourceType: 'cms_page', resourceId: 'p1', body: 'have a look', mentions: ['user_dana', 'user_lee'],
    }));
    expect(api.postComment).toHaveBeenCalledTimes(1);
    // CM2UX-2 — a persistent Notice (not a toast the success announcement overwrote).
    expect(await screen.findByText(/Not notified.*Lee/)).toBeTruthy();
    expect(toasts.warning).not.toHaveBeenCalled();
  });
});

describe('D6 — resolution + edit metadata', () => {
  it('renders (edited), the mention chips, and who resolved it', async () => {
    api.readThread.mockResolvedValue({
      comments: [row('c1', 'user_dana', { editedAt: '2026-01-02T00:00:00.000Z', mentions: ['user_lee'], status: 'resolved', resolvedBy: 'user_me', resolvedAt: '2026-01-03T00:00:00.000Z' })],
      viewer: ME,
    });
    view();
    await screen.findByText('body c1');
    expect(screen.getByText('(edited)')).toBeTruthy();
    expect(screen.getByText('@Lee')).toBeTruthy();
    expect(screen.getByText(/Resolved by Me/)).toBeTruthy();
  });
});

describe('CM2UX-1 / CM2UX-8', () => {
  it('Edit moves focus into the box, Escape cancels and hands focus back to Edit', async () => {
    api.readThread.mockResolvedValue({ comments: [row('c1', 'user_me')], viewer: ME });
    view();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    const box = screen.getByRole('textbox', { name: /edit comment/i });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /edit/i })));
  });

  it('a refused mention gets its own copy, not "check the text"', async () => {
    const { CommentsHttpError } = await import('../commentsClient.js');
    api.readThread.mockResolvedValue({ comments: [], viewer: ME });
    api.postComment.mockRejectedValue(new CommentsHttpError('x', 400, 'validation_error', 'mentions'));
    view();
    fireEvent.change(await screen.findByRole('textbox', { name: /new comment/i }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /^comment$/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('no longer in this organization')));
  });
});
