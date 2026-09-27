import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { getOptIn, listEnrollments } = vi.hoisted(() => ({
  getOptIn: vi.fn(),
  listEnrollments: vi.fn(),
}));

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null, loading: false, isConfigured: true }),
}));
vi.mock('../../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">Sign in to KickTodo</button>,
}));
vi.mock('../../../client/kicktodoEngagementClient.js', () => ({
  getOptIn,
  joinLeaderboard: vi.fn(),
  leaveLeaderboard: vi.fn(),
  getLeaderboard: vi.fn(),
  getAwards: vi.fn(),
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments,
  listChallenges: vi.fn(),
}));

import { EngagementPage } from '../EngagementPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EngagementPage signed out', () => {
  it('explains opt-in privacy and never offers or loads the leaderboard', () => {
    render(<EngagementPage />);

    expect(screen.getByText(en.signedOutTitle)).toBeTruthy();
    expect(screen.getByText(en.signedOutPrivacy)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in to KickTodo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.joinCta })).toBeNull();
    expect(getOptIn).not.toHaveBeenCalled();
    expect(listEnrollments).not.toHaveBeenCalled();
  });
});
