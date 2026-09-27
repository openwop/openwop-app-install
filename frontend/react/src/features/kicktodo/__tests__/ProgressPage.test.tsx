import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const kt = vi.hoisted(() => ({
  listEnrollmentsWithProgress: vi.fn(),
  listChallengesForLocale: vi.fn(),
}));

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kt,
}));

import { ProgressPage } from '../ProgressPage.js';
import { messages as en } from '../i18n/en.js';

const progress = (overrides: Record<string, unknown> = {}) => ({
  enrollmentId: 'enroll-focus',
  state: 'active',
  goalState: null,
  currentDay: 4,
  durationDays: 14,
  totalRequiredActivities: 10,
  completedActivities: 4,
  checkInCount: 3,
  trace: [],
  recovery: { offered: 0, completed: 0 },
  ...overrides,
});

const mount = () => render(<MemoryRouter><ProgressPage /></MemoryRouter>);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  kt.listChallengesForLocale.mockResolvedValue([{ challenge: { id: 'focus', title: 'Focus gently' } }]);
  kt.listEnrollmentsWithProgress.mockResolvedValue({
    enrollments: [{ id: 'enroll-focus', challengeId: 'focus' }],
    progress: { 'enroll-focus': progress() },
  });
});

describe('Progress — evidence-led journey', () => {
  it('separates plan position, observed evidence, interpretation, and the next move', async () => {
    mount();

    expect(await screen.findByRole('heading', { name: 'Focus gently' })).toBeTruthy();
    expect(screen.getByText(en.progressPlanHeading)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: '4 of 10 required actions complete' })).toBeTruthy();
    expect(screen.getByText(en.progressFigObserved)).toBeTruthy();
    expect(screen.getByRole('heading', { name: en.progressNarrativeBuildingTitle })).toBeTruthy();
    expect(screen.getByRole('heading', { name: en.progressNextActionTitle })).toBeTruthy();
    expect(screen.getByRole('link', { name: en.navTodayLabel }).getAttribute('href')).toBe('/today');
  });

  it('states an unknown plan basis instead of fabricating zero progress', async () => {
    kt.listEnrollmentsWithProgress.mockResolvedValue({
      enrollments: [{ id: 'enroll-focus', challengeId: 'focus' }],
      progress: { 'enroll-focus': progress({ totalRequiredActivities: 0, completedActivities: 0 }) },
    });

    mount();

    expect(await screen.findByText(en.progressPlanUnknown)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.body.textContent).not.toContain('0%');
  });

  it('turns a failed read into an announced, working recovery action', async () => {
    kt.listEnrollmentsWithProgress
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ enrollments: [], progress: {} });

    mount();

    expect(await screen.findByText(en.progressLoadErrorBody)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.progressRetry }));
    await waitFor(() => expect(kt.listEnrollmentsWithProgress).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('link', { name: en.browseChallenges })).toBeTruthy();
  });
});
