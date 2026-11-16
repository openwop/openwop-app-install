/**
 * ADR 0517 fix D — what the chat SHOWS for each BYOK state.
 *
 * The bug was here, not just in the data layer: `!config || !isValid` collapsed
 * "backend down", "signed out", and "genuinely no key" into ONE branch, and that
 * branch was the first-run wizard. So a user whose session had merely lapsed was
 * told to add an API key they had already added, and adding it again minted a
 * duplicate secret. These pin each state to its own honest surface.
 *
 * Sabotage witnesses (w43, re-probed w113): dropping the loading or error branch,
 * the session-expired branch, the stored-refs seed, the error prop, or either side
 * of `needsWizard` each turn a case red.
 *
 * ADR 0944: the wizard is now `lazy`, so a SYNCHRONOUS "no wizard" check could
 * never fail (the chunk had not resolved yet). Every case therefore settles first
 * (`settle`), and the needs-key case reads the wizard synchronously after the
 * SAME settle — its positive control that the settle is long enough for the lazy
 * wizard to mount.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { BYOKActiveConfig, UseBYOKConfigResult } from '../../byok/lib/useBYOKConfig.js';
const useBYOKConfig = vi.fn<() => UseBYOKConfigResult>();
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
// The stub surfaces the `error` prop: the card jumps straight to "resting" on it
// (BackendStatusCard.test), so an outage that never reaches the card is a lie.
vi.mock('../BackendStatusCard.js', () => ({
  BackendStatusCard: (p: { error?: string | null }) => <div data-testid="backend-status" data-error={p.error ?? ''} />,
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: false }),
}));
// The ready branch lazily registers `/p-` prompt commands, which reads the org
// list over the network; a stub keeps the ready case off a live fetch.
vi.mock('../promptCommands.js', () => ({ registerWorkspacePromptCommands: vi.fn(async () => undefined) }));
vi.mock('../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null, loading: false, isConfigured: true, signIn: { google: vi.fn(), github: vi.fn() }, signOut: vi.fn() }),
}));

const { ChatTab } = await import('../ChatTab.js');
// Warm the (mocked) wizard module so the lazy import resolves within `settle`.
await import('../../byok/BYOKWizard.js');

/** Let the lazy wizard chunk resolve and commit, so an absent wizard is evidence. */
const settle = (): Promise<void> => act(async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => { setTimeout(r, 0); });
});

const GOOGLE: BYOKActiveConfig = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' };

function state(over: Partial<UseBYOKConfigResult>): void {
  useBYOKConfig.mockReturnValue({
    config: null, status: 'needs-key', isValid: false, isLoading: false,
    storedRefs: [], error: null, setConfig: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined),
    stored: true, signInRequired: false,
    ...over,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ChatTab BYOK states (ADR 0517)', () => {
  it('ready → the chat', async () => {
    state({ status: 'ready', isValid: true, config: GOOGLE });
    render(<MemoryRouter><ChatTab /></MemoryRouter>);
    await settle();
    expect(screen.getByTestId('chat')).toBeTruthy();
    expect(screen.queryByTestId('wizard')).toBeNull();
  });

  it('loading → the status card, never the wizard', async () => {
    state({ status: 'loading', isLoading: true });
    render(<MemoryRouter><ChatTab /></MemoryRouter>);
    await settle();
    expect(screen.getByTestId('backend-status').getAttribute('data-error')).toBe('');
    expect(screen.queryByTestId('wizard')).toBeNull();
  });

  it('error → the status card, NEVER a key prompt', async () => {
    // An outage is not evidence that a key is missing. Prompting here is how a
    // user with a perfectly good key was talked into storing a second one.
    state({ status: 'error', error: 'backend unreachable' });
    render(<MemoryRouter><ChatTab /></MemoryRouter>);
    await settle();
    // …and the outage itself reaches the card (which shows it and goes "resting").
    expect(screen.getByTestId('backend-status').getAttribute('data-error')).toBe('backend unreachable');
    expect(screen.queryByTestId('wizard')).toBeNull();
  });

  it('session-expired → the sign-in card, NEVER the key wizard', async () => {
    // The reported bug, at the surface where the user met it.
    state({ status: 'session-expired' });
    render(<MemoryRouter><ChatTab /></MemoryRouter>);
    await settle();
    expect(screen.getByTestId('session-expired')).toBeTruthy();
    expect(screen.queryByTestId('wizard')).toBeNull();
  });

  it('needs-key → the wizard, SEEDED with stored refs so it can offer an existing key', async () => {
    state({ status: 'needs-key', storedRefs: ['byok:google:1785358774187'] });
    render(<MemoryRouter><ChatTab /></MemoryRouter>);
    await settle();
    // Synchronous on purpose: the positive control for every other case's settle.
    const wizard = screen.getByTestId('wizard');
    // Fix A depends on this prop actually arriving; without it the wizard is
    // blind to keys the workspace already has and mints another.
    expect(wizard.getAttribute('data-refs')).toBe('byok:google:1785358774187');
  });
});
