import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listCircles, listEnrollments } = vi.hoisted(() => ({
  listCircles: vi.fn(),
  listEnrollments: vi.fn(),
}));

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null, loading: false, isConfigured: true }),
}));
vi.mock('../../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">Sign in to KickTodo</button>,
}));
vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers: vi.fn() }));
vi.mock('../../../client/kicktodoClient.js', () => ({ listEnrollments }));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listCircles,
  createCircle: vi.fn(),
  listGrants: vi.fn(),
  invite: vi.fn(),
  revoke: vi.fn(),
  getFeed: vi.fn(),
  listSessions: vi.fn(),
  scheduleSession: vi.fn(),
  listProposals: vi.fn(),
  resolveProposalAction: vi.fn(),
}));

import { CirclesPage } from '../CirclesPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CirclesPage signed out', () => {
  it('explains private sharing and never requests tenant-scoped circle data', () => {
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);

    expect(screen.getByText(en.signedOutTitle)).toBeTruthy();
    expect(screen.getByText(en.signedOutPrivacy)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in to KickTodo' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: en.coachOpenConsole })).toBeNull();
    expect(listCircles).not.toHaveBeenCalled();
    expect(listEnrollments).not.toHaveBeenCalled();
    expect(screen.queryByText(en.loadError)).toBeNull();
  });
});
