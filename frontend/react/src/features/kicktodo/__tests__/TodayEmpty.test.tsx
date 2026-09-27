import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const featured = {
  id: 'chal:focus',
  version: 1,
  status: 'published',
  title: 'Focus gently',
  summary: 'Protect one useful block without making the rest of the day brittle.',
  outcome: 'A repeatable focus rhythm.',
  durationDays: 14,
  activities: [],
};

vi.mock('../../../auth/backendSession.js', () => ({
  useBackendSession: () => ({ user: null, resolved: true }),
}));
const kt = vi.hoisted(() => ({
  getToday: vi.fn(),
  listEnrollments: vi.fn(),
  listChallenges: vi.fn(),
}));

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kt,
}));

import { TodayPage } from '../TodayPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  kt.getToday.mockResolvedValue({ dateLocal: '2026-09-19', enrollments: [] });
  kt.listEnrollments.mockResolvedValue([]);
  kt.listChallenges.mockResolvedValue([featured]);
});

describe('Today — first-use state', () => {
  it('explains the loop, offers one primary next step, and uses real catalog inventory', async () => {
    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: en.todayEmptyTitle })).toBeTruthy());
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: new RegExp(en.todayGuideCta) }).getAttribute('href')).toBe('/guide');
    expect(screen.getByRole('link', { name: new RegExp(en.browseChallenges) }).getAttribute('href')).toBe('/discover');
    expect(screen.getByRole('link', { name: /Focus gently/ }).getAttribute('href')).toBe('/discover/chal%3Afocus');
    expect(screen.getByText(en.todayEmptyStepChoose)).toBeTruthy();
    expect(screen.getByText(en.todayEmptyStepFit)).toBeTruthy();
    expect(screen.getByText(en.todayEmptyStepReturn)).toBeTruthy();
  });

  it('confirms a just-created plan only after the fresh enrollment read verifies it', async () => {
    kt.getToday.mockResolvedValue({
      dateLocal: '2026-09-19',
      enrollments: [{ enrollmentId: 'enrollment-new', challengeId: 'chal:focus', challengeVersion: 1, state: 'active', actions: [] }],
    });
    kt.listEnrollments.mockResolvedValue([{ id: 'enrollment-new', challengeId: 'chal:focus', state: 'active' }]);
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/today',
        state: { kicktodoWelcome: { enrollmentId: 'enrollment-new', challengeTitle: 'Focus gently' } },
      }]}>
        <TodayPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(en.todayWelcomeTitle.replace('{{title}}', 'Focus gently'))).toBeTruthy();
    expect(screen.getByText(en.todayWelcomeBody)).toBeTruthy();
  });

  it('does not trust a fabricated welcome for an enrollment the server did not return', async () => {
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/today',
        state: { kicktodoWelcome: { enrollmentId: 'not-real', challengeTitle: 'Invented challenge' } },
      }]}>
        <TodayPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: en.todayEmptyTitle })).toBeTruthy());
    expect(screen.queryByText(/Invented challenge/)).toBeNull();
  });
});
