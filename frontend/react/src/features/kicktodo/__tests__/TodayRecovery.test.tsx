import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../auth/backendSession.js', () => ({
  useBackendSession: () => ({ user: null, resolved: true }),
}));

const kt = vi.hoisted(() => ({
  getToday: vi.fn(),
  listEnrollments: vi.fn(),
  listChallenges: vi.fn(),
  acceptRecovery: vi.fn(),
  setSnooze: vi.fn(),
  setSchedulePreference: vi.fn(),
  checkIn: vi.fn(),
  substituteAction: vi.fn(),
}));

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kt,
}));

import { TodayPage } from '../TodayPage.js';
import { messages as en } from '../i18n/en.js';

const challenge = (id: string, title: string) => ({
  id,
  version: 1,
  status: 'published',
  title,
  summary: `${title} summary`,
  outcome: `${title} outcome`,
  durationDays: 14,
  activities: [],
});

const action = (id: string, title: string) => ({
  occurrence: {
    cardId: `card-${id}`,
    stableActivityId: id,
    occurrenceDateLocal: '2026-09-20',
    evidencePolicy: 'attestation',
  },
  alternatives: [],
  card: { id: `card-${id}`, title, description: 'A useful next step.', columnId: 'todo', completed: false },
  checkIn: null,
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  kt.acceptRecovery.mockResolvedValue(true);
  kt.setSnooze.mockResolvedValue(undefined);
  kt.listEnrollments.mockResolvedValue([]);
  kt.listChallenges.mockResolvedValue([
    challenge('chal:focus', 'Focus gently'),
    challenge('chal:move', 'Move daily'),
  ]);
});

describe('Today — humane recovery and capacity', () => {
  it('previews the exact recovery impact before adding one bounded action', async () => {
    kt.getToday.mockResolvedValue({
      dateLocal: '2026-09-20',
      enrollments: [{
        enrollmentId: 'enroll-focus', challengeId: 'chal:focus', challengeVersion: 1, state: 'active',
        recovery: { missed: 2, mode: 'offer' }, actions: [action('focus', 'Protect a focus block')],
      }],
    });

    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: en.recoveryOfferTitle.replace('{{count}}', '2') })).toBeTruthy();
    expect(screen.getByText(en.recoveryOfferImpact)).toBeTruthy();
    expect(screen.getByText(en.whyThisActionPlan.replace('{{title}}', 'Focus gently'))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en.recoveryAddAction }));
    await waitFor(() => expect(kt.acceptRecovery).toHaveBeenCalledWith('enroll-focus'));
    expect(await screen.findByText(en.recoveryAddedNotice.replace('{{count}}', '2'))).toBeTruthy();
  });

  it('turns overload into an explicit, reversible capacity decision', async () => {
    kt.getToday.mockResolvedValue({
      dateLocal: '2026-09-20',
      enrollments: [
        { enrollmentId: 'enroll-focus', challengeId: 'chal:focus', challengeVersion: 1, state: 'active', actions: [action('focus', 'Protect a focus block'), action('review', 'Review the day')] },
        { enrollmentId: 'enroll-move', challengeId: 'chal:move', challengeVersion: 1, state: 'active', actions: [action('move', 'Take a short walk')] },
      ],
    });

    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    await screen.findByText(en.capacityTitle);
    fireEvent.click(screen.getByText(en.capacityTitle));

    expect(screen.getByText(en.capacitySummary.replace('{{due}}', '3').replace('{{challenges}}', '2'))).toBeTruthy();
    expect(screen.getByText(en.capacityPauseImpact.replace('{{count}}', '2'))).toBeTruthy();
    expect(screen.getByRole('button', { name: en.snoozeNamed.replace('{{title}}', 'Focus gently') })).toBeTruthy();
  });

  it('keeps a paused plan visible and resumable instead of claiming the day is complete', async () => {
    kt.getToday.mockResolvedValue({
      dateLocal: '2026-09-20',
      enrollments: [{ enrollmentId: 'enroll-focus', challengeId: 'chal:focus', challengeVersion: 1, state: 'snoozed', actions: [] }],
    });

    render(<MemoryRouter><TodayPage /></MemoryRouter>);

    expect(await screen.findByText(en.allPausedTitle)).toBeTruthy();
    expect(screen.queryByText(en.allCaughtUpTitle)).toBeNull();
    expect(screen.queryByText(en.summaryAllDone)).toBeNull();
    expect(screen.getByRole('button', { name: `${en.resume}: Focus gently` })).toBeTruthy();
  });
});
