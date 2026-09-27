/**
 * ADR 0517 fix D — what the chat SHOWS for each BYOK state.
 *
 * The bug was here, not just in the data layer: `!config || !isValid` collapsed
 * "backend down", "signed out", and "genuinely no key" into ONE branch, and that
 * branch was the first-run wizard. So a user whose session had merely lapsed was
 * told to add an API key they had already added, and adding it again minted a
 * duplicate secret. These pin each state to its own honest surface.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const useBYOKConfig = vi.fn();
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../byok/lib/useBYOKConfig.js', () => ({ useBYOKConfig: () => useBYOKConfig() }));

vi.mock('../../byok/BYOKWizard.js', () => ({
  BYOKWizard: (p: { storedRefs?: readonly string[] }) =>
    <div data-testid="wizard" data-refs={(p.storedRefs ?? []).join(',')} />,
}));
vi.mock('../SessionExpiredCard.js', () => ({
  SessionExpiredCard: () => <div data-testid="session-expired" />,
}));
vi.mock('../ChatSidebar.js', () => ({ ChatSidebar: () => <div data-testid="chat" /> }));
vi.mock('../BackendStatusCard.js', () => ({ BackendStatusCard: () => <div data-testid="backend-status" /> }));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: false }),
}));
vi.mock('../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null, loading: false, isConfigured: true, signIn: { google: vi.fn(), github: vi.fn() }, signOut: vi.fn() }),
}));

const { ChatTab } = await import('../ChatTab.js');

const GOOGLE = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' };

function state(over: Record<string, unknown>) {
  useBYOKConfig.mockReturnValue({
    config: null, status: 'needs-key', isValid: false, isLoading: false,
    storedRefs: [], error: null, setConfig: vi.fn(), refresh: vi.fn(),
    ...over,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ChatTab BYOK states (ADR 0517)', () => {
  it('ready → the chat', () => {
    state({ status: 'ready', isValid: true, config: GOOGLE });
    render(<ChatTab />);
    expect(screen.getByTestId('chat')).toBeTruthy();
  });

  it('loading → the status card, never the wizard', () => {
    state({ status: 'loading', isLoading: true });
    render(<ChatTab />);
    expect(screen.getByTestId('backend-status')).toBeTruthy();
    expect(screen.queryByTestId('wizard')).toBeNull();
  });

  it('error → the status card, NEVER a key prompt', () => {
    // An outage is not evidence that a key is missing. Prompting here is how a
    // user with a perfectly good key was talked into storing a second one.
    state({ status: 'error', error: 'backend unreachable' });
    render(<ChatTab />);
    expect(screen.getByTestId('backend-status')).toBeTruthy();
    expect(screen.queryByTestId('wizard')).toBeNull();
  });

  it('session-expired → the sign-in card, NEVER the key wizard', () => {
    // The reported bug, at the surface where the user met it.
    state({ status: 'session-expired' });
    render(<ChatTab />);
    expect(screen.getByTestId('session-expired')).toBeTruthy();
    expect(screen.queryByTestId('wizard')).toBeNull();
  });

  it('needs-key → the wizard, SEEDED with stored refs so it can offer an existing key', () => {
    state({ status: 'needs-key', storedRefs: ['byok:google:1785358774187'] });
    render(<ChatTab />);
    const wizard = screen.getByTestId('wizard');
    expect(wizard).toBeTruthy();
    // Fix A depends on this prop actually arriving; without it the wizard is
    // blind to keys the workspace already has and mints another.
    expect(wizard.getAttribute('data-refs')).toBe('byok:google:1785358774187');
  });
});
