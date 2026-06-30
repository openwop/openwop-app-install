/**
 * ADR 0117 Phase 3 — CompareView (read-only side-by-side conversations).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

const { listChatSessions, listChatSessionMessages } = vi.hoisted(() => ({
  listChatSessions: vi.fn(), listChatSessionMessages: vi.fn(),
}));
vi.mock('../../client/chatSessionsClient.js', () => ({ listChatSessions, listChatSessionMessages }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { CompareView } from '../CompareView.js';

const msg = (id: string, role: string, content: string) => ({ messageId: id, sessionId: 's', role, content, createdAt: 't' });

beforeEach(() => { listChatSessions.mockReset(); listChatSessionMessages.mockReset(); cleanup(); });

describe('CompareView', () => {
  it('renders the current conversation in the left pane + a picker of OTHER sessions', async () => {
    listChatSessions.mockResolvedValue([{ sessionId: 'cur', title: 'Current' }, { sessionId: 'other', title: 'Other chat' }]);
    listChatSessionMessages.mockResolvedValue([msg('m1', 'user', 'hello left')]);
    render(<CompareView currentSessionId="cur" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('hello left')).toBeTruthy());
    // The picker excludes the current session, offers the other.
    expect(screen.getByText('Other chat')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Current' })).toBeNull();
  });

  it('loads the right pane when a second conversation is picked', async () => {
    listChatSessions.mockResolvedValue([{ sessionId: 'cur', title: 'Current' }, { sessionId: 'other', title: 'Other chat' }]);
    listChatSessionMessages.mockImplementation((id: string) => Promise.resolve(
      id === 'other' ? [msg('r1', 'assistant', 'hello right')] : [msg('m1', 'user', 'hello left')]));
    render(<CompareView currentSessionId="cur" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('hello left')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('compareWith'), { target: { value: 'other' } });
    await waitFor(() => expect(screen.getByText('hello right')).toBeTruthy());
  });
});
