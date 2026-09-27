import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConversationsRail } from '../ConversationsRail.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';

/**
 * ADR 0140 amend — the multi-tab deck mounts ConversationsRail as a persistent
 * LIST (no single "open conversation"), so Zone 1 (the agent lineup) is omitted.
 * These assert the rail renders and behaves as a pure list in that mode.
 */

const CONVERSATIONS: ChatSessionHeader[] = [
  { sessionId: 'chan-1', title: 'my-team-channel', type: 'channel', messageCount: 4 } as ChatSessionHeader,
  { sessionId: 'ag-1', title: 'Support Triage', type: 'agent', messageCount: 2 } as ChatSessionHeader,
];

function renderRail(overrides: Partial<Parameters<typeof ConversationsRail>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <ConversationsRail
      conversations={CONVERSATIONS}
      isLoading={false}
      error={null}
      activeSessionId="chan-1"
      onRefresh={vi.fn(() => Promise.resolve())}
      onSelect={onSelect}
      onRename={vi.fn(() => Promise.resolve())}
      onDelete={vi.fn(() => Promise.resolve())}
      onNewChat={vi.fn()}
      onOpenWorkspace={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
  return { onSelect };
}

afterEach(() => cleanup());

describe('ConversationsRail — list-only mode (deck)', () => {
  it('renders the conversation list without an agent lineup (Zone 1 omitted)', () => {
    renderRail({ selectionEcho: true });
    // The rows render (the button's accessible name is the title + a count subtitle)...
    expect(screen.getByRole('button', { name: /my-team-channel/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Support Triage/ })).toBeTruthy();
    // ...and the lineup's "switch voice" affordance is absent (no open-conversation zone).
    expect(screen.queryByText('In this conversation')).toBeNull();
  });

  it('softens the active row to an echo when selectionEcho is set', () => {
    const { container } = render(
      <ConversationsRail
        conversations={CONVERSATIONS}
        isLoading={false}
        error={null}
        activeSessionId="chan-1"
        onRefresh={vi.fn(() => Promise.resolve())}
        onSelect={vi.fn()}
        onRename={vi.fn(() => Promise.resolve())}
        onDelete={vi.fn(() => Promise.resolve())}
        onNewChat={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onClose={vi.fn()}
        selectionEcho
      />,
    );
    expect(container.querySelector('.conversations-rail')?.getAttribute('data-selection-echo')).toBe('true');
  });

  it('selecting a row calls onSelect with its id', () => {
    const { onSelect } = renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Support Triage/ }));
    expect(onSelect).toHaveBeenCalledWith('ag-1');
  });

  it('shows the empty state (with New chat) when there are no conversations', () => {
    renderRail({ conversations: [] });
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
  });
});
