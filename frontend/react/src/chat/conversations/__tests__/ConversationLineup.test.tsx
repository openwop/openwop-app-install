import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { ConversationLineup } from '../ConversationLineup.js';
import type { ActiveAgentRow } from '../../activeAgents/types.js';

/**
 * ADR 0304 P2 residue — the live-boardroom speaking pulse on the lineup.
 *
 * Guards: the agent whose settled turn is being VOICED shows "Speaking" on ITS
 * row (its tagline yields), speaking outranks thinking on the same row, nothing
 * speaks when `speakingAgentId` is null, and the strip chip exposes the floor as
 * a `role=status` named "Speaking". Every assertion is scoped to a row, so a
 * speaking state that lands on the wrong agent goes red (sabotage
 * `isSpeaking={row.agentId === currentAgentId}`, w44 cl-speak-row).
 */

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
    const ada = screen.getByRole('button', { name: 'Switch to Ada' });
    expect(within(ada).getByText(/Speaking/)).toBeTruthy();
    expect(within(ada).queryByText('Finance lens')).toBeNull(); // the tagline yields
    // No other row speaks, and the other rows keep their taglines.
    expect(screen.getAllByText(/Speaking/)).toHaveLength(1);
    expect(within(screen.getByRole('button', { name: 'Switch to Rex' })).getByText('Pipeline lens')).toBeTruthy();
  });

  it('speaking outranks thinking on the same row', () => {
    renderLineup({ speakingAgentId: 'ada', thinkingAgentId: 'ada' });
    const ada = screen.getByRole('button', { name: 'Switch to Ada' });
    expect(within(ada).getByText(/Speaking/)).toBeTruthy();
    expect(screen.queryByText(/Thinking/)).toBeNull();
  });

  it('renders no speaking state when absent (default null — pre-0304 behavior)', () => {
    renderLineup({ thinkingAgentId: 'rex' });
    expect(screen.queryByText(/Speaking/)).toBeNull();
    expect(within(screen.getByRole('button', { name: 'Switch to Rex' })).getByText(/Thinking/)).toBeTruthy();
  });

  it('strip variant marks the speaking chip with the audible-floor icon', () => {
    renderLineup({ variant: 'strip', speakingAgentId: 'rex' });
    const rex = screen.getByRole('button', { name: 'Switch to Rex' });
    expect(within(rex).getByRole('status', { name: 'Speaking' })).toBeTruthy();
    expect(screen.getAllByRole('status', { name: 'Speaking' })).toHaveLength(1);
  });
});
