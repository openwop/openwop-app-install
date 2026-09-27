import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const authState = vi.hoisted(() => ({ user: null as { uid: string } | null }));

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: authState.user, isConfigured: true, loading: false }),
}));
vi.mock('../../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">Sign in</button>,
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  getToday: vi.fn(async () => ({ dateLocal: '2026-09-19', enrollments: [] })),
  listEnrollments: vi.fn(async () => []),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({ listProposals: vi.fn(async () => []) }));
vi.mock('../../../agents/rosterClient.js', () => ({
  getRosterEntry: vi.fn(async () => ({ label: 'Ember', persona: 'KickBot' })),
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
  });

  it('gives a signed-in participant a plain-language activation path', () => {
    authState.user = { uid: 'u1' };
    renderPage();
    expect(screen.getByText(en.guideActivateTitle)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.guideActivateCta }).getAttribute('href')).toBe('/?agent=host:kickbot');
    expect(screen.queryByText(/provider|credential|BYOK/i)).toBeNull();
  });
});
