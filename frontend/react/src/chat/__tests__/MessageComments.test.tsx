/**
 * ADR 0021 (inline-in-chat extension) — a collapsed "Comment" affordance under a
 * chat message that expands the SHARED CommentsPanel scoped to the
 * `chat_message` thread `${sessionId}#${messageId}`.
 *
 * Two claims: (1) collapsed by default, so a feed's first render fires NO comment
 * read (no N+1 / rate-limit fan-out); (2) expanding scopes the thread to
 * exactly `chat_message` + `${sessionId}#${messageId}` and the toggle reports
 * `aria-expanded`. What breaks it: mounting the panel unconditionally reds (1);
 * a different resource type/id or a constant `aria-expanded` reds (2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { Comment, ResourceType, ThreadViewer } from '../../features/comments/commentsClient.js';

// Mock the Comments client the panel ACTUALLY imports. Spread the real module so
// every export it uses (incl. `CommentsHttpError`) is present; override the reads
// and writes so nothing reaches the network.
const readThread = vi.hoisted(() => vi.fn<(orgId: string, type: ResourceType, id: string) => Promise<{ comments: Comment[]; viewer: ThreadViewer | null }>>());
vi.mock('../../features/comments/commentsClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/comments/commentsClient.js')>()),
  readThread: (orgId: string, type: ResourceType, id: string) => readThread(orgId, type, id),
  listThread: vi.fn(async () => []),
  postComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  listOrgs: vi.fn(async () => []),
}));

// The panel's org-member directory (author names / mention picker) reads live
// otherwise; an empty directory is enough for these cases.
vi.mock('../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => []),
  invalidateOrgMembers: vi.fn(),
}));

// ADR 0659 D7 (`CMNT-UX-20`) — the panel resolves the caller's org-scoped write
// access. Mocked here so these cases stay about the read/write lanes they are
// named for: the default is a member who CAN write, which is what the
// assertions below assume. `commentsPanelAccess.test.tsx` drives the other arms.
const orgAccess = vi.hoisted(() => ({ value: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' } }));
vi.mock('../../client/useEffectiveAccess.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../client/useEffectiveAccess.js')>();
  return { ...orig, useOrgEffectiveAccess: () => orgAccess.value };
});

import { MessageComments } from '../MessageComments.js';

beforeEach(() => { readThread.mockReset(); readThread.mockResolvedValue({ comments: [], viewer: null }); });
afterEach(cleanup);

describe('MessageComments (ADR 0021 inline-in-chat)', () => {
  it('is collapsed by default and mounts no comment thread (no fetch on load)', () => {
    render(<MessageComments orgId="org-1" sessionId="sess-9" messageId="msg-3" />);
    const toggle = screen.getByRole('button', { name: 'Show comments on this message' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed ⇒ the panel is unmounted ⇒ its thread was never requested.
    expect(readThread).not.toHaveBeenCalled();
    expect(screen.queryByText('No comments yet')).toBeNull();
  });

  it('expands on click and scopes the thread to `${sessionId}#${messageId}` as a chat_message', async () => {
    render(<MessageComments orgId="org-1" sessionId="sess-9" messageId="msg-3" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show comments on this message' }));
    await waitFor(() => expect(readThread).toHaveBeenCalledWith('org-1', 'chat_message', 'sess-9#msg-3'));
    expect(readThread).toHaveBeenCalledTimes(1);
    // The panel settled into its loaded (empty) state — not the read-failed card.
    expect(await screen.findByText('No comments yet')).toBeTruthy();
    expect(screen.queryByText('Could not load this')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show comments on this message' }).getAttribute('aria-expanded')).toBe('true');
  });
});
