/**
 * "Leave challenge" on Progress. Before this, nothing in the SPA called the
 * abandon route, so snoozing was the only way out of a challenge.
 *
 * The confirmation says only what the route does (backend
 * `kicktodo-leave-keeps-record.test.ts` pins each claim): the actions stop, the
 * record and journal are kept, the card stays as an ended journey, and the same
 * challenge cannot be restarted. It offers snooze for a break.
 *
 * Red when: the confirm stops stating any of that, the button calls the route
 * without a confirm or after a cancel, or it is offered on an ended journey.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Enrollment, NegotiatedChallenge, ProgressView } from '../../../client/kicktodoClient.js';
import type { abandonEnrollment, listChallengesForLocale, listEnrollmentsWithProgress } from '../../../client/kicktodoClient.js';
import type { ConfirmOptions } from '../../../ui/confirm.js';

const kt = vi.hoisted(() => ({
  listEnrollmentsWithProgress: vi.fn<typeof listEnrollmentsWithProgress>(),
  listChallengesForLocale: vi.fn<typeof listChallengesForLocale>(),
  abandonEnrollment: vi.fn<typeof abandonEnrollment>(),
}));
const confirmFn = vi.hoisted(() => vi.fn<(o: ConfirmOptions) => Promise<boolean>>());

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kt,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmFn, ConfirmRoot: () => null }));

import { ProgressPage } from '../ProgressPage.js';
import { messages as en } from '../i18n/en.js';

const progress = (overrides: Partial<ProgressView> = {}): ProgressView => ({
  enrollmentId: 'enroll-focus', state: 'active', goalState: null, currentDay: 4, durationDays: 14,
  totalRequiredActivities: 10, completedActivities: 4, checkInCount: 3, trace: [],
  recovery: { offered: 0, completed: 0 }, ...overrides,
});
const enrollment = (state: Enrollment['state']): Enrollment => ({
  id: 'enroll-focus', challengeId: 'focus', challengeVersion: 1, state, goalId: 'goal-focus',
  planRevision: 1, timezone: 'UTC', startDateLocal: '2026-09-01',
});
const catalog: NegotiatedChallenge[] = [{
  challenge: { id: 'focus', version: 1, status: 'published', title: 'Focus gently', summary: 's', outcome: 'o', durationDays: 14, activities: [] },
  servedLocale: 'en', exactLocale: true,
}];

const mount = () => render(<MemoryRouter><ProgressPage /></MemoryRouter>);
const leaveButton = () => screen.findByRole('button', { name: 'Leave “Focus gently”' });

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  kt.listChallengesForLocale.mockResolvedValue(catalog);
  kt.listEnrollmentsWithProgress.mockResolvedValue({ enrollments: [enrollment('active')], progress: { 'enroll-focus': progress() } });
  kt.abandonEnrollment.mockResolvedValue(enrollment('abandoned'));
});

describe('Progress — Leave challenge', () => {
  it('asks first, and the confirm says exactly what leaving does', async () => {
    confirmFn.mockResolvedValue(false);
    mount();
    fireEvent.click(await leaveButton());
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    const opts = confirmFn.mock.calls[0]![0];
    expect(opts.title).toBe('Leave “Focus gently”?');
    expect(opts.confirmLabel).toBe(en.leaveChallenge);
    expect(opts.danger).toBe(true);
    const body = String(opts.body);
    expect(body).toContain('reminders for this challenge stop');
    expect(body).toContain('check-ins and journal entries are kept');
    expect(body).toContain('stays on Progress as an ended journey');
    expect(body).toContain('can’t restart this same challenge');
    expect(body).toContain('snooze it from Today');
  });

  it('cancel makes no call', async () => {
    confirmFn.mockResolvedValue(false);
    mount();
    fireEvent.click(await leaveButton());
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    expect(kt.abandonEnrollment).not.toHaveBeenCalled();
    expect(kt.listEnrollmentsWithProgress).toHaveBeenCalledTimes(1);
  });

  it('confirm calls abandon for that enrollment, then re-reads Progress', async () => {
    confirmFn.mockResolvedValue(true);
    mount();
    fireEvent.click(await leaveButton());
    await waitFor(() => expect(kt.abandonEnrollment).toHaveBeenCalledWith('enroll-focus'));
    await waitFor(() => expect(kt.listEnrollmentsWithProgress).toHaveBeenCalledTimes(2));
  });

  it('a failed leave is announced', async () => {
    confirmFn.mockResolvedValue(true);
    kt.abandonEnrollment.mockRejectedValue(new Error('500'));
    mount();
    fireEvent.click(await leaveButton());
    expect(await screen.findByText(en.leaveError)).toBeTruthy();
  });

  it('is offered for a snoozed journey but never for an ended one', async () => {
    kt.listEnrollmentsWithProgress.mockResolvedValue({ enrollments: [enrollment('snoozed')], progress: { 'enroll-focus': progress({ state: 'snoozed' }) } });
    mount();
    expect(await leaveButton()).toBeTruthy();
    cleanup();
    kt.listEnrollmentsWithProgress.mockResolvedValue({
      enrollments: [enrollment('abandoned')],
      progress: { 'enroll-focus': progress({ state: 'abandoned', goalState: 'abandoned' }) },
    });
    mount();
    expect(await screen.findByText(en.progressEndedChip)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leave “Focus gently”' })).toBeNull();
  });
});
