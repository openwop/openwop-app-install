/**
 * Guided-achievement UX — Discover must help a visitor choose by real-life fit,
 * not by title alone. The filtering is deterministic and every surviving card
 * explains the exact user-selected constraints it matched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false }) }));

const activities = (days: number, minutes: number) => Array.from({ length: days }, (_, index) => ({
  stableActivityId: `a-${index + 1}`,
  day: index + 1,
  title: 'Do the step',
  instructions: 'Begin gently.',
  estimatedMinutes: minutes,
  evidencePolicy: 'attestation',
}));

const catalog = [
  {
    id: 'chal:quick-focus', version: 1, status: 'published', title: 'Quick Focus',
    summary: 'Protect a small focus block.', outcome: 'A calmer focus rhythm.',
    durationDays: 7, activities: activities(7, 10), depthLevel: 'beginner' as const,
  },
  {
    id: 'chal:deep-work', version: 1, status: 'published', title: 'Deep Work',
    summary: 'Build a substantial practice.', outcome: 'Longer uninterrupted work.',
    durationDays: 30, activities: activities(30, 30), depthLevel: 'advanced' as const,
  },
];

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publicChallengeCatalog: vi.fn(async () => catalog),
  recommendedChallenges: vi.fn(async () => []),
}));

import { DiscoverPage } from '../DiscoverPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);

describe('Discover — explainable real-life fit', () => {
  it('filters by time and duration and explains the constraints the card matched', async () => {
    render(<MemoryRouter><DiscoverPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Quick Focus')).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox', { name: en.discoverTimeBudgetLabel }), { target: { value: '10' } });
    fireEvent.change(screen.getByRole('combobox', { name: en.discoverDurationBudgetLabel }), { target: { value: '14' } });

    expect(screen.getByText('Quick Focus')).toBeTruthy();
    expect(screen.queryByText('Deep Work')).toBeNull();
    expect(screen.getByText(en.discoverFitLabel)).toBeTruthy();
    expect(screen.getByText(`${en.discoverFitTime.replace('{{count}}', '10')} · ${en.discoverFitDuration.replace('{{count}}', '7')}`)).toBeTruthy();
  });

  it('states a keyword match without presenting it as an opaque recommendation', async () => {
    render(<MemoryRouter><DiscoverPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Quick Focus')).toBeTruthy());

    fireEvent.change(screen.getByRole('searchbox', { name: en.discoverSearchLabel }), { target: { value: 'calmer' } });

    expect(screen.getByText('Quick Focus')).toBeTruthy();
    expect(screen.queryByText('Deep Work')).toBeNull();
    expect(screen.getByText(en.discoverFitGoal.replace('{{query}}', 'calmer'))).toBeTruthy();
  });
});
