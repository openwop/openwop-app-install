/**
 * ADR 0436 §5.4 (Discover) — guided-achievement fit: Discover must help a
 * visitor choose by real-life fit, not by title alone. The filtering is
 * deterministic and every surviving card explains the exact user-selected
 * constraints it matched.
 *
 * What breaks it: dropping the time-per-day or the plan-length predicate from
 * DiscoverPage's `shown` filter (a challenge over the budget is offered), or
 * dropping a fit reason from the card (the match is no longer explained).
 *
 * The fixture is a 2×2 of {7, 30 days} × {10, 30 min/day}, so each filter has a
 * challenge that ONLY it excludes ("Short Heavy" fails time alone, "Long Light"
 * fails length alone). With only Quick Focus / Deep Work, Deep Work failed BOTH
 * filters and removing either one changed nothing (w42 probes
 * w42g2-df-time-filter / -duration-filter were vacuous).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as KickTodoClient from '../../../client/kicktodoClient.js';
import type { ChallengeActivity, ChallengeSummary } from '../../../client/kicktodoClient.js';

vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false }) }));

const fixtures = vi.hoisted(() => {
  const activities = (days: number, minutes: number): ChallengeActivity[] => Array.from({ length: days }, (_, index) => ({
    stableActivityId: `a-${index + 1}`,
    day: index + 1,
    title: 'Do the step',
    instructions: 'Begin gently.',
    estimatedMinutes: minutes,
    evidencePolicy: 'attestation',
  }));
  const challenge = (id: string, title: string, outcome: string, days: number, minutes: number): ChallengeSummary => ({
    id, version: 1, status: 'published', title, summary: `About ${title}.`, outcome,
    durationDays: days, activities: activities(days, minutes),
  });
  const catalog: ChallengeSummary[] = [
    challenge('chal:quick-focus', 'Quick Focus', 'A calmer focus rhythm.', 7, 10),
    challenge('chal:deep-work', 'Deep Work', 'Longer uninterrupted work.', 30, 30),
    challenge('chal:short-heavy', 'Short Heavy', 'An intense week.', 7, 30),
    challenge('chal:long-light', 'Long Light', 'A gentle month.', 30, 10),
  ];
  return { catalog };
});

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof KickTodoClient>()),
  publicChallengeCatalog: vi.fn<typeof KickTodoClient.publicChallengeCatalog>(async () => fixtures.catalog),
  recommendedChallenges: vi.fn<typeof KickTodoClient.recommendedChallenges>(async () => []),
}));

import { DiscoverPage } from '../DiscoverPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);

const ALL = ['Quick Focus', 'Deep Work', 'Short Heavy', 'Long Light'];
const fitTime = (n: number): string => en.discoverFitTime.replace('{{count}}', String(n));
const fitDays = (n: number): string => en.discoverFitDuration_other.replace('{{count}}', String(n));

const mount = async (): Promise<void> => {
  render(<MemoryRouter><DiscoverPage /></MemoryRouter>);
  // Positive control before any absence: the whole catalog rendered.
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Quick Focus' })).toBeTruthy());
  for (const title of ALL) expect(screen.getByRole('heading', { name: title })).toBeTruthy();
};
const shownTitles = (): string[] => ALL.filter((title) => screen.queryByRole('heading', { name: title }) !== null);
/** The fit explanation on ONE card — the paragraph under "Matches your filters". */
const fitOf = (title: string): string | null => {
  const card = screen.getByRole('heading', { name: title }).closest('article');
  if (!card) throw new Error(`no card for ${title}`);
  return within(card).getByText(en.discoverFitLabel).nextElementSibling?.textContent ?? null;
};
const setTime = (v: string) => fireEvent.change(screen.getByRole('combobox', { name: en.discoverTimeBudgetLabel }), { target: { value: v } });
const setDays = (v: string) => fireEvent.change(screen.getByRole('combobox', { name: en.discoverDurationBudgetLabel }), { target: { value: v } });

describe('Discover — explainable real-life fit', () => {
  it('filters by time and duration and explains the constraints the card matched', async () => {
    await mount();
    setTime('10');
    setDays('14');

    expect(shownTitles()).toEqual(['Quick Focus']);
    expect(fitOf('Quick Focus')).toBe(`${fitTime(10)} · ${fitDays(7)}`);
  });

  it('the time budget ALONE hides a challenge over the daily minutes and explains the time fit', async () => {
    await mount();
    setTime('10');

    expect(shownTitles()).toEqual(['Quick Focus', 'Long Light']);
    expect(fitOf('Quick Focus')).toBe(fitTime(10));
    expect(fitOf('Long Light')).toBe(fitTime(10));
  });

  it('the plan-length budget ALONE hides a longer plan and explains the duration fit', async () => {
    await mount();
    setDays('14');

    expect(shownTitles()).toEqual(['Quick Focus', 'Short Heavy']);
    expect(fitOf('Quick Focus')).toBe(fitDays(7));
    expect(fitOf('Short Heavy')).toBe(fitDays(7));
  });

  it('states a keyword match without presenting it as an opaque recommendation', async () => {
    await mount();
    fireEvent.change(screen.getByRole('searchbox', { name: en.discoverSearchLabel }), { target: { value: 'calmer' } });

    expect(shownTitles()).toEqual(['Quick Focus']);
    expect(fitOf('Quick Focus')).toBe(en.discoverFitGoal.replace('{{query}}', 'calmer'));
  });
});
