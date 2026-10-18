/**
 * ADR 0117 Phase 3 — CompareView (read-only side-by-side conversations).
 * Breaks if the picker offers the current session against itself, or either
 * pane renders the wrong session's transcript.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

type Client = typeof import('../../client/chatSessionsClient.js');
const { listChatSessions, listChatSessionMessages } = vi.hoisted(() => ({
  listChatSessions: vi.fn<Client['listChatSessions']>(), listChatSessionMessages: vi.fn<Client['listChatSessionMessages']>(),
}));
vi.mock('../../client/chatSessionsClient.js', () => ({ listChatSessions, listChatSessionMessages }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { CompareView } from '../CompareView.js';
import type { ChatMessagePersisted, ChatSessionHeader } from '../../client/chatSessionsClient.js';

const msg = (id: string, role: ChatMessagePersisted['role'], content: string): ChatMessagePersisted =>
  ({ messageId: id, sessionId: 's', role, content, meta: null, createdAt: '2026-01-01T00:00:00.000Z' });
const hdr = (sessionId: string, title: string): ChatSessionHeader =>
  ({ sessionId, tenantId: 't', title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 });

beforeEach(() => { listChatSessions.mockReset(); listChatSessionMessages.mockReset(); cleanup(); });

describe('CompareView', () => {
  it('renders the current conversation in the left pane + a picker of OTHER sessions', async () => {
    listChatSessions.mockResolvedValue([hdr('cur', 'Current'), hdr('other', 'Other chat')]);
    listChatSessionMessages.mockResolvedValue([msg('m1', 'user', 'hello left')]);
    render(<CompareView currentSessionId="cur" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('hello left')).toBeTruthy());
    // The picker excludes the current session, offers the other.
    expect(screen.getByText('Other chat')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Current' })).toBeNull();
  });

  it('loads the right pane when a second conversation is picked', async () => {
    listChatSessions.mockResolvedValue([hdr('cur', 'Current'), hdr('other', 'Other chat')]);
    listChatSessionMessages.mockImplementation((id) => Promise.resolve(
      id === 'other' ? [msg('r1', 'assistant', 'hello right')] : [msg('m1', 'user', 'hello left')]));
    render(<CompareView currentSessionId="cur" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('hello left')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('compareWith'), { target: { value: 'other' } });
    await waitFor(() => expect(screen.getByText('hello right')).toBeTruthy());
  });
});
