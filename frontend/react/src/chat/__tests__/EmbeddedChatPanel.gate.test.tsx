/**
 * ADR 0073 embed BYOK gate (grade-pass F11-nit/ST-2): with no valid provider
 * config the panel renders the DESIGNED gate state (StateCard + manage
 * action), never the conversation; a custom byokFallback replaces it wholesale.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../byok/lib/useBYOKConfig.js', () => ({
  useBYOKConfig: vi.fn(() => ({ config: null, isValid: false })),
}));
// The conversation core must NOT mount behind the gate — stub it to detect.
vi.mock('../EmbeddedConversation.js', () => ({
  EmbeddedConversation: () => <div data-testid="embedded-conversation" />,
}));

import { EmbeddedChatPanel } from '../EmbeddedChatPanel.js';
afterEach(cleanup);

describe('EmbeddedChatPanel BYOK gate', () => {
  it('renders the designed gate (not the conversation) when no valid config', () => {
    render(<MemoryRouter><EmbeddedChatPanel agentId="feature.kicktodo.agents.challenge-author" /></MemoryRouter>);
    expect(screen.queryByTestId('embedded-conversation')).toBeNull();
    // The gate copy + manage action (shared chat-ns keys).
    expect(screen.getByText('Connect an AI provider to use AI here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open chat to set it up' })).toBeTruthy();
  });

  it('byokFallback replaces the default gate wholesale', () => {
    render(
      <MemoryRouter>
        <EmbeddedChatPanel agentId="x" byokFallback={<p>custom gate</p>} />
      </MemoryRouter>,
    );
    expect(screen.getByText('custom gate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open chat to set it up' })).toBeNull();
  });
});
