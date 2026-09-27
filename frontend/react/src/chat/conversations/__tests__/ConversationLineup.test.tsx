import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ConversationLineup } from '../ConversationLineup.js';
import type { ActiveAgentRow } from '../../activeAgents/types.js';

/** ADR 0304 P2 residue — the live-boardroom speaking pulse on the lineup. */

const LINEUP: ActiveAgentRow[] = [
  { agentId: 'assistant', persona: 'Default', slug: 'assistant', modelClass: 'balanced', addedAt: '' },
  { agentId: 'ada', persona: 'Finance lens', slug: 'ada', modelClass: 'balanced', addedAt: '2026-01-01' },
  { agentId: 'rex', persona: 'Pipeline lens', slug: 'rex', modelClass: 'balanced', addedAt: '2026-01-01' },
];

function renderLineup(over: Partial<Parameters<typeof ConversationLineup>[0]> = {}) {
  render(
    <ConversationLineup
      lineup={LINEUP}
      currentAgentId="assistant"
      thinkingAgentId={null}
      onSwitchAgent={vi.fn()}
      onRemoveAgent={vi.fn()}
      {...over}
    />,
  );
}

afterEach(() => cleanup());

describe('ConversationLineup — speaking pulse (ADR 0304)', () => {
  it('shows "Speaking" on the agent whose turn is being voiced', () => {
    renderLineup({ speakingAgentId: 'ada' });
    expect(screen.getByText(/Speaking/)).toBeTruthy();
    // The other rows keep their taglines.
    expect(screen.getByText('Pipeline lens')).toBeTruthy();
  });

  it('speaking outranks thinking on the same row', () => {
    renderLineup({ speakingAgentId: 'ada', thinkingAgentId: 'ada' });
    expect(screen.getByText(/Speaking/)).toBeTruthy();
    expect(screen.queryByText(/Thinking/)).toBeNull();
  });

  it('renders no speaking state when absent (default null — pre-0304 behavior)', () => {
    renderLineup({ thinkingAgentId: 'rex' });
    expect(screen.queryByText(/Speaking/)).toBeNull();
    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });

  it('strip variant marks the speaking chip with the audible-floor icon', () => {
    renderLineup({ variant: 'strip', speakingAgentId: 'rex' });
    expect(screen.getByLabelText('Speaking')).toBeTruthy();
  });
});
