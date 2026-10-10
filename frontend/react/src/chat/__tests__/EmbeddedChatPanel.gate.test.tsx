/**
 * ADR 0073 embed BYOK gate (grade-pass F11-nit/ST-2): with no valid provider
 * config the panel renders the DESIGNED gate state (StateCard + manage
 * action), never the conversation; a custom byokFallback replaces it wholesale.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../byok/lib/useBYOKConfig.js', () => ({
  useBYOKConfig: vi.fn(() => ({ config: null, isValid: false, status: 'needs-key', refresh: vi.fn() })),
}));
vi.mock('../../auth/useAuth.js', () => ({
  useAuth: () => ({ signIn: { google: vi.fn() }, isConfigured: true }),
}));
// The conversation core must NOT mount behind the gate — stub it to detect.
vi.mock('../EmbeddedConversation.js', () => ({
  EmbeddedConversation: () => <div data-testid="embedded-conversation" />,
}));

import { EmbeddedChatPanel } from '../EmbeddedChatPanel.js';
import { useBYOKConfig } from '../../byok/lib/useBYOKConfig.js';
afterEach(cleanup);

describe('EmbeddedChatPanel BYOK gate', () => {
  it('renders the designed gate (not the conversation) when no valid config', () => {
    render(<MemoryRouter><EmbeddedChatPanel agentId="vendor.openwop-app.kicktodo.agents.challenge-author" /></MemoryRouter>);
    expect(screen.queryByTestId('embedded-conversation')).toBeNull();
    // The gate copy + manage action (shared chat-ns keys).
    expect(screen.getByText('Connect an AI provider to use AI here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open chat to set it up' })).toBeTruthy();
  });

  // grade-ux CHATUX-2 (ADR 0764) — only `needs-key` means "connect a provider".
  it('a signed-out session offers sign-in, NEVER "connect a provider"', () => {
    vi.mocked(useBYOKConfig).mockReturnValueOnce({ config: null, isValid: false, status: 'session-expired', refresh: vi.fn() } as never);
    render(<MemoryRouter><EmbeddedChatPanel agentId="x" /></MemoryRouter>);
    expect(screen.queryByText('Connect an AI provider to use AI here.')).toBeNull();
    expect(screen.queryByTestId('embedded-conversation')).toBeNull();
  });

  it('an outage says the server was unreachable and offers a retry — not a key prompt', () => {
    const refresh = vi.fn();
    vi.mocked(useBYOKConfig).mockReturnValueOnce({ config: null, isValid: false, status: 'error', refresh } as never);
    render(<MemoryRouter><EmbeddedChatPanel agentId="x" /></MemoryRouter>);
    expect(screen.queryByText('Connect an AI provider to use AI here.')).toBeNull();
    expect(screen.getByText('Couldn’t reach the server to check your AI provider.')).toBeTruthy();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(refresh).toHaveBeenCalledOnce();
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

  // ADR 0768 follow-up C1 — the loading state was the one gate state untested.
  // While the binding resolves we know NOTHING, so claiming "connect a provider"
  // would be a false statement to a user who has one (ADR 0517).
  it('while the binding resolves it holds the space quietly — never a key prompt, never the conversation', () => {
    vi.mocked(useBYOKConfig).mockReturnValueOnce({ config: null, isValid: false, status: 'loading', refresh: vi.fn() } as never);
    const { container } = render(<MemoryRouter><EmbeddedChatPanel agentId="x" /></MemoryRouter>);
    expect(container.querySelector('.embed-byok-gate')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Connect an AI provider to use AI here.')).toBeNull();
    expect(screen.queryByTestId('embedded-conversation')).toBeNull();
  });
});
