/**
 * KickTodo Guide activation (ADR 0436 §5.8 → ADR 0442 Guide wave; #4031 "close
 * public and first-use UX gaps"). The page hands the shared chat a `byokFallback`
 * that depends on WHO is looking: an anonymous visitor (`isConfigured && !user`)
 * is asked to sign in, never shown provider/BYOK setup; a signed-in participant
 * gets a plain-language activation deep-link to `/?agent=host:kickbot`.
 * Breaks if: `anonymous` stops choosing the card, the two cards render together,
 * the activation link moves, or provider jargon reaches participant copy.
 * (The EmbeddedChatPanel stub renders the page's own `byokFallback` prop — the
 * branch under test is the page's, not the stub's.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { RosterEntry } from '../../../agents/rosterClient.js';
import type { TodayView } from '../../../client/kicktodoClient.js';

const authState = vi.hoisted(() => ({ user: null as { uid: string } | null }));
const fx = vi.hoisted(() => {
  const roster: RosterEntry = {
    rosterId: 'host:kickbot', persona: 'KickBot', label: 'Ember', agentRef: { agentId: 'kickbot' },
    workflows: [], tenantId: 't1', enabled: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  };
  const today: TodayView = { dateLocal: '2026-09-19', enrollments: [] };
  return { roster, today };
});

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: authState.user, isConfigured: true, loading: false }),
}));
vi.mock('../../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">Sign in</button>,
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  getToday: vi.fn(async () => fx.today),
  listEnrollments: vi.fn(async () => []),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({ listProposals: vi.fn(async () => []) }));
vi.mock('../../../agents/rosterClient.js', () => ({
  getRosterEntry: vi.fn(async () => fx.roster),
  updateRosterEntry: vi.fn(),
}));
vi.mock('../../agent-knowledge/agentKnowledgeClient.js', () => ({
  listNotes: vi.fn(async () => []),
  deleteNote: vi.fn(),
}));
vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: ({ byokFallback }: { byokFallback?: ReactNode }) => <div data-testid="guide-activation">{byokFallback}</div>,
}));

import { GuidePage } from '../GuidePage.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => { cleanup(); authState.user = null; });

const renderPage = () => render(<MemoryRouter><GuidePage /></MemoryRouter>);

describe('Guide — participant-facing activation', () => {
  it('asks an anonymous participant to sign in without exposing provider setup', () => {
    renderPage();
    expect(screen.getByText(en.guideSignInTitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText(/provider/i)).toBeNull();
    expect(screen.queryByText(en.guideActivateTitle)).toBeNull();
    expect(screen.queryByRole('link', { name: en.guideActivateCta })).toBeNull();
  });

  it('gives a signed-in participant a plain-language activation path', () => {
    authState.user = { uid: 'u1' };
    renderPage();
    expect(screen.getByText(en.guideActivateTitle)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.guideActivateCta }).getAttribute('href')).toBe('/?agent=host:kickbot');
    expect(screen.queryByText(/provider|credential|BYOK/i)).toBeNull();
    expect(screen.queryByText(en.guideSignInTitle)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});
