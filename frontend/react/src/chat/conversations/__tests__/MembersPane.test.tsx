import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MembersPane } from '../MembersPane.js';
import type { ActiveAgentRow } from '../../activeAgents/types.js';

/**
 * ADR 0140 follow-on — the shared right-docked members pane (deck + ChatSidebar).
 * Renders the active conversation's roster (agent case here) with the shared
 * ConversationLineup.
 */

const LINEUP: ActiveAgentRow[] = [
  { agentId: 'assistant', persona: 'Default', slug: 'assistant', modelClass: 'balanced', addedAt: '' },
  { agentId: 'iris', persona: 'Chief of Staff', slug: 'iris', modelClass: 'balanced', addedAt: '2026-01-01' },
];

function renderPane(onClose = vi.fn(), onSwitchAgent = vi.fn()) {
  render(
    <MembersPane
      isChannel={false}
      channelId="s1"
      lineup={LINEUP}
      currentAgentId="assistant"
      thinkingAgentId={null}
      onSwitchAgent={onSwitchAgent}
      onRemoveAgent={vi.fn()}
      onClose={onClose}
    />,
  );
}

afterEach(() => cleanup());

describe('MembersPane', () => {
  it('renders the roster heading and the agent lineup', () => {
    renderPane();
    expect(screen.getByRole('complementary', { name: 'In this conversation' })).toBeTruthy();
    expect(screen.getByText('Chief of Staff')).toBeTruthy();
  });

  it('calls onClose from the close control', () => {
    const onClose = vi.fn();
    renderPane(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close members' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
