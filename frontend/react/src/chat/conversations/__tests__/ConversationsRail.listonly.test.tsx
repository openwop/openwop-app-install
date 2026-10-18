import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ConversationsRail } from '../ConversationsRail.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';

/**
 * ConversationsRail as a pure conversation LIST (ADR 0043; ADR 0140 amend — the
 * deck and the sidebar both mount it list-only, the members zone lives in the
 * right-docked MembersPane). Guards: each conversation renders as a selectable row
 * in its type section, `selectionEcho` softens the active row (and only when set),
 * picking a row hands over THAT row's id, and an empty list offers New chat.
 *
 * Breaks if rows drop out of their sections (sabotage `items.slice(1)`), the echo
 * attribute is lost, onSelect receives the wrong id, or the empty state vanishes
 * (w44 cr-rows / cr-echo / cr-select / cr-empty).
 */

const CONVERSATIONS: ChatSessionHeader[] = [
  { sessionId: 'chan-1', tenantId: 't', title: 'my-team-channel', type: 'channel', messageCount: 4, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' },
  { sessionId: 'ag-1', tenantId: 't', title: 'Support Triage', type: 'agent', messageCount: 2, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' },
];

function renderRail(overrides: Partial<Parameters<typeof ConversationsRail>[0]> = {}) {
  const onSelect = vi.fn();
  const onNewChat = vi.fn();
  const { container } = render(
    <ConversationsRail
      conversations={CONVERSATIONS}
      isLoading={false}
      error={null}
      activeSessionId="chan-1"
      onRefresh={vi.fn(() => Promise.resolve())}
      onSelect={onSelect}
      onRename={vi.fn(() => Promise.resolve())}
      onDelete={vi.fn(() => Promise.resolve())}
      onNewChat={onNewChat}
      onOpenWorkspace={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
  return { onSelect, onNewChat, container };
}

afterEach(() => cleanup());

describe('ConversationsRail — list-only mode (deck)', () => {
  it('renders each conversation as a selectable row in its type section', () => {
    renderRail({ selectionEcho: true });
    // The button's accessible name is the title + a count subtitle.
    expect(within(screen.getByRole('region', { name: 'Channels' })).getByRole('button', { name: /my-team-channel/ })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Agents' })).getByRole('button', { name: /Support Triage/ })).toBeTruthy();
  });

  it('softens the active row to an echo when selectionEcho is set', () => {
    const echo = renderRail({ selectionEcho: true });
    expect(echo.container.querySelector('.conversations-rail')?.getAttribute('data-selection-echo')).toBe('true');
    cleanup();
    const plain = renderRail();
    expect(plain.container.querySelector('.conversations-rail')?.hasAttribute('data-selection-echo')).toBe(false);
  });

  it('selecting a row calls onSelect with its id', () => {
    const { onSelect } = renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Support Triage/ }));
    expect(onSelect).toHaveBeenCalledWith('ag-1');
  });

  it('shows the empty state (with New chat) when there are no conversations', () => {
    const { onNewChat } = renderRail({ conversations: [] });
    expect(screen.getByText('No conversations yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });
});
