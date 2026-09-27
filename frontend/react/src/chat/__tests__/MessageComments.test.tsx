import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Mock the Comments client so the reused CommentsPanel loads a deterministic
// (empty) thread instead of hitting the network. We assert MessageComments
// wires the correct chat_message resourceId through to the shared panel.
const listThread = vi.fn();
vi.mock('../../features/comments/commentsClient.js', () => ({
  RESOURCE_TYPES: ['cms_page', 'kb_collection'],
  listThread: (...args: unknown[]) => listThread(...args),
  postComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  listOrgs: vi.fn(),
}));

// ADR 0659 D7 (`CMNT-UX-20`) — the panel resolves the caller's org-scoped write
// access. Mocked here so these cases stay about the read/write lanes they are
// named for: the default is a member who CAN write, which is what the
// assertions below assume. `commentsPanelAccess.test.tsx` drives the other arms.
const orgAccess = vi.hoisted(() => ({ value: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' } as unknown }));
vi.mock('../../client/useEffectiveAccess.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, useOrgEffectiveAccess: () => orgAccess.value };
});

import { MessageComments } from '../MessageComments.js';

beforeEach(() => { listThread.mockReset(); listThread.mockResolvedValue([]); });
afterEach(cleanup);

describe('MessageComments (ADR 0021 inline-in-chat)', () => {
  it('is collapsed by default and mounts no comment thread (no fetch on load)', () => {
    render(<MessageComments orgId="org-1" sessionId="sess-9" messageId="msg-3" />);
    const toggle = screen.getByRole('button', { name: 'Show comments on this message' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed ⇒ the panel is unmounted ⇒ its thread was never requested.
    expect(listThread).not.toHaveBeenCalled();
  });

  it('expands on click and scopes the thread to `${sessionId}#${messageId}` as a chat_message', async () => {
    render(<MessageComments orgId="org-1" sessionId="sess-9" messageId="msg-3" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show comments on this message' }));
    await waitFor(() => expect(listThread).toHaveBeenCalledWith('org-1', 'chat_message', 'sess-9#msg-3'));
    expect(screen.getByRole('button', { name: 'Show comments on this message' }).getAttribute('aria-expanded')).toBe('true');
  });
});
