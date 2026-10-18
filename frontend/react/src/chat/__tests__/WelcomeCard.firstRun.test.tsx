/**
 * SHELL-4 — the first-run "getting started" layer in WelcomeCard. Pins the
 * component wiring the firstRunFlag unit test can't reach:
 *  - a signed-in user with no dismissal flag sees the strip;
 *  - a user who already dismissed (flag set) does NOT;
 *  - an anonymous/loading session (no uid) does NOT;
 *  - "Skip intro" removes the strip AND persists the per-uid flag.
 * Uses the REAL firstRunFlag against jsdom localStorage; mocks only the async
 * data deps (auth, roster, profile, workflow mentions, template preload).
 *
 * Sabotage witnesses (w43): ignoring the dismissal flag, never revealing the
 * strip, and a Skip that does not persist or does not hide each turn a case red.
 * DOUBLE GUARD, recorded: the anonymous case is held twice — the component's
 * `!!uid &&` AND `isFirstRunDismissed`'s own `if (!uid) return true` — so
 * removing either alone stays green (w43 probes wfr-uid-guard / wfr-flag-nouid).
 * The shared piece is the composed reveal predicate; the w43 re-probe removes
 * both guards together and turns the anonymous case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn<() => UseAuth>() }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: useAuthMock }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('../lib/agentMentions.js', () => ({ useAgentMentions: () => ({ entries: [] }) }));
vi.mock('../lib/workflowMentions.js', () => ({
  listWorkflowMentions: () => [],
  refreshWorkflowMentionCache: async () => undefined,
  workflowMentionLoadFailed: () => false,
}));
vi.mock('../../features/profiles/profilesClient.js', () => ({ getMyProfile: async () => ({}) }));
vi.mock('../../agents/rosterClient.js', () => ({ listRoster: async () => [] }));

import { WelcomeCard } from '../WelcomeCard.js';
import { firstRunKey } from '../../onboarding/firstRunFlag.js';
import type { UseAuth } from '../../auth/useAuth.js';
import type { AuthUser } from '../../auth/firebase.js';

const U1: AuthUser = { uid: 'u1', email: null, displayName: null, photoURL: null, providerIds: [] };
/** A production-shaped `useAuth()` result for `user` (null = anonymous). */
function auth(user: AuthUser | null): UseAuth {
  return {
    user, loading: false, isConfigured: true,
    signIn: { google: async () => undefined, github: async () => undefined },
    signOut: async () => undefined,
  };
}

beforeEach(() => { localStorage.clear(); useAuthMock.mockReset(); });
afterEach(() => cleanup());

describe('WelcomeCard — first-run strip (SHELL-4)', () => {
  it('shows the getting-started strip for a signed-in first-timer', async () => {
    useAuthMock.mockReturnValue(auth(U1));
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    expect(await screen.findByText('firstRunSkip')).toBeTruthy();
    expect(screen.getByText('firstRunStepConnectTitle')).toBeTruthy();
  });

  it('does NOT show the strip once dismissed (per-uid flag set)', async () => {
    localStorage.setItem(firstRunKey('getStarted', 'u1'), 'x');
    useAuthMock.mockReturnValue(auth(U1));
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    // the steady heading renders; give the reveal effect a tick to (not) fire.
    await waitFor(() => expect(screen.getByText('welcomeHeading')).toBeTruthy());
    expect(screen.queryByText('firstRunSkip')).toBeNull();
  });

  it('does NOT show the strip for an anonymous/loading session (no uid)', async () => {
    useAuthMock.mockReturnValue(auth(null));
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('welcomeHeading')).toBeTruthy());
    expect(screen.queryByText('firstRunSkip')).toBeNull();
  });

  it('Skip intro removes the strip and persists the per-uid flag', async () => {
    useAuthMock.mockReturnValue(auth(U1));
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    const skip = await screen.findByText('firstRunSkip');
    expect(localStorage.getItem(firstRunKey('getStarted', 'u1'))).toBeNull();
    fireEvent.click(skip);
    await waitFor(() => expect(screen.queryByText('firstRunSkip')).toBeNull());
    expect(localStorage.getItem(firstRunKey('getStarted', 'u1'))).not.toBeNull();
  });
});
