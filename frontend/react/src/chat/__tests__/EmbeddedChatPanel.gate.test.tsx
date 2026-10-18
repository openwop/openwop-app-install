/**
 * ADR 0073 embed BYOK gate (grade-pass F11-nit/ST-2): with no valid provider
 * config the panel renders the DESIGNED gate state (StateCard + manage
 * action), never the conversation; a custom byokFallback replaces it wholesale.
 *
 * Sabotage witnesses (w43): opening the gate, dropping the byokFallback,
 * session-expired, error or loading branch, the retry wiring, the gate copy, the
 * default manage navigation, or the outage card's `announce` each turn a case red.
 * The positive control (a valid config mounts the conversation, scoped to the
 * agent) is what makes every "never the conversation" absence able to fail.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BYOKStatus, UseBYOKConfigResult } from '../../byok/lib/useBYOKConfig.js';
import type { UseAuth } from '../../auth/useAuth.js';

/** A production-shaped `useBYOKConfig()` result for `status`. */
function byok(status: BYOKStatus, over: Partial<UseBYOKConfigResult> = {}): UseBYOKConfigResult {
  return {
    config: null, status, isValid: false, isLoading: status === 'loading',
    storedRefs: [], error: null,
    setConfig: async () => undefined, refresh: async () => undefined,
    stored: true, signInRequired: false,
    ...over,
  };
}

vi.mock('../../byok/lib/useBYOKConfig.js', () => ({
  useBYOKConfig: vi.fn((): UseBYOKConfigResult => ({
    config: null, status: 'needs-key', isValid: false, isLoading: false,
    storedRefs: [], error: null,
    setConfig: async () => undefined, refresh: async () => undefined,
    stored: true, signInRequired: false,
  })),
}));
vi.mock('../../auth/useAuth.js', () => ({
  useAuth: (): UseAuth => ({
    user: null, loading: false, isConfigured: true,
    signIn: { google: async () => undefined, github: async () => undefined },
    signOut: async () => undefined,
  }),
}));
// The conversation core must NOT mount behind the gate — stub it to detect.
vi.mock('../EmbeddedConversation.js', () => ({
  EmbeddedConversation: (p: { agentId: string }) => <div data-testid="embedded-conversation" data-agent={p.agentId} />,
}));

import { EmbeddedChatPanel } from '../EmbeddedChatPanel.js';
import { useBYOKConfig } from '../../byok/lib/useBYOKConfig.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';

beforeEach(() => {
  // The announcer is module-global; an empty message resets both channels.
  announce(''); announce('', { assertive: true });
});
afterEach(cleanup);

describe('EmbeddedChatPanel BYOK gate', () => {
  it('renders the designed gate (not the conversation) when no valid config, and its manage action works', () => {
    const onManage = vi.fn();
    render(<MemoryRouter><EmbeddedChatPanel agentId="vendor.openwop-app.kicktodo.agents.challenge-author" onManageProvider={onManage} /></MemoryRouter>);
    expect(screen.queryByTestId('embedded-conversation')).toBeNull();
    // The gate copy + manage action (shared chat-ns keys).
    expect(screen.getByText('Connect an AI provider to use AI here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat to set it up' }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('without an override, the manage action sends the user to the chat route (which owns BYOK setup)', () => {
    render(
      <MemoryRouter initialEntries={['/feature']}>
        <Routes>
          <Route path="/" element={<p>chat home</p>} />
          <Route path="/feature" element={<EmbeddedChatPanel agentId="x" />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open chat to set it up' }));
    expect(screen.getByText('chat home')).toBeTruthy();
  });

  // grade-ux CHATUX-2 (ADR 0764) — only `needs-key` means "connect a provider".
  it('a signed-out session offers sign-in, NEVER "connect a provider"', () => {
    vi.mocked(useBYOKConfig).mockReturnValueOnce(byok('session-expired'));
    render(<MemoryRouter><EmbeddedChatPanel agentId="x" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Sign back in' })).toBeTruthy();
    expect(screen.queryByText('Connect an AI provider to use AI here.')).toBeNull();
    expect(screen.queryByTestId('embedded-conversation')).toBeNull();
  });

  it('an outage says the server was unreachable and offers a retry — not a key prompt', () => {
    const refresh = vi.fn(async () => undefined);
    vi.mocked(useBYOKConfig).mockReturnValueOnce(byok('error', { refresh }));
    render(<MemoryRouter><EmbeddedChatPanel agentId="x" /></MemoryRouter>);
    expect(screen.queryByText('Connect an AI provider to use AI here.')).toBeNull();
    expect(screen.getByText('Couldn’t reach the server to check your AI provider.')).toBeTruthy();
    // "Says" includes a screen-reader user: the swapped-in card is announced.
    expect(currentAnnouncements().polite).toContain('Couldn’t reach the server to check your AI provider.');
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
    vi.mocked(useBYOKConfig).mockReturnValueOnce(byok('loading'));
    const { container } = render(<MemoryRouter><EmbeddedChatPanel agentId="x" /></MemoryRouter>);
    expect(container.querySelector('.embed-byok-gate')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Connect an AI provider to use AI here.')).toBeNull();
    expect(screen.queryByTestId('embedded-conversation')).toBeNull();
  });

  // Positive control for every absence above: the stub IS the module the panel
  // mounts, and a valid binding reaches it scoped to the requested agent.
  it('a valid binding mounts the conversation, scoped to the agent', () => {
    vi.mocked(useBYOKConfig).mockReturnValueOnce(byok('ready', {
      config: { provider: 'anthropic', model: 'claude-opus-5-5', credentialRef: 'byok:anthropic' }, isValid: true,
    }));
    render(<MemoryRouter><EmbeddedChatPanel agentId="vendor.openwop-app.cad.agents.modeler" /></MemoryRouter>);
    expect(screen.getByTestId('embedded-conversation').getAttribute('data-agent')).toBe('vendor.openwop-app.cad.agents.modeler');
    expect(screen.queryByText('Connect an AI provider to use AI here.')).toBeNull();
  });
});
