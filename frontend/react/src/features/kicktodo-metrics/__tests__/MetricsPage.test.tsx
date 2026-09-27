/**
 * ADR 0432 P4 — the metrics page's two honesty rules, pinned (this feature had
 * no frontend test at all):
 *  - a WITHHELD cell says why and never renders a value — not "0", not "—";
 *  - every rate shows its contributor count, so no percentage carries an
 *    implied denominator;
 * plus: one batched load (each read called exactly once), the verifier section
 * refuses to invent a rate when nothing has been graded, and a failed read is
 * an honest error, not an empty table.
 *
 * Mock shapes match the client's exported types (`FlooredCell`), because a
 * mock whose shape drifts from the API makes the branch under test unreachable
 * (the engagement page test recorded exactly that bug).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import type { ActivationMetrics, EngagementMetrics, FactoryMetrics, VerifierQuality } from '../../../client/kicktodoMetricsClient.js';

const state = {
  activation: {
    daysToFirstCompletedActionP50: { value: 2, contributors: 12 },
    enrollmentsStarted: 30,
    enrollmentsWithAnyCompletion: { value: 18, contributors: 30 },
  } as ActivationMetrics,
  engagement: {
    weeklyMeaningfulProgress: { value: 9, contributors: 30 },
    retentionD7: { value: 0.5, contributors: 30 },
    retentionD30: { value: null, contributors: 3, withheldReason: 'below-k-floor' },
    completionRate: { value: 0.25, contributors: 30 },
    abandonmentRate: { value: 0.1, contributors: 30 },
    recoveryRate7d: { value: null, contributors: 4, withheldReason: 'below-k-floor' },
  } as EngagementMetrics,
  factory: { candidatesByState: { planned: 2, published: 3 }, publishRate: { value: 0.6, contributors: 5 } } as FactoryMetrics,
  verifier: { sampled: 0, resolved: 0, agreed: 0, falsePositives: 0, falseNegatives: 0, disagreementRate: null } as VerifierQuality,
  fail: false,
};

vi.mock('../../../client/kicktodoMetricsClient.js', () => ({
  getActivation: vi.fn(async () => { if (state.fail) throw new Error('503'); return state.activation; }),
  getEngagement: vi.fn(async () => state.engagement),
  getFactory: vi.fn(async () => state.factory),
  getVerifierQuality: vi.fn(async () => state.verifier),
}));

import { MetricsPage } from '../MetricsPage.js';
import { getActivation, getEngagement, getFactory, getVerifierQuality } from '../../../client/kicktodoMetricsClient.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => { cleanup(); state.fail = false; vi.clearAllMocks(); });

describe('MetricsPage (ADR 0432 P4)', () => {
  it('a withheld cell says why and renders NO value; every shown rate carries its contributor count', async () => {
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(en.mRetentionD30)).toBeTruthy());
    // Two withheld cells (D30, recovery) — the chip, not a number.
    expect(screen.getAllByText(en.withheld)).toHaveLength(2);
    // "Renders NO value" is a NEGATIVE claim, so it needs a negative assertion
    // scoped to the row: presence checks elsewhere on the page are satisfied by a
    // superset, and a regression that rendered `12%` beside the chip would have
    // passed every line below. (Steward review of #3843; same species as the
    // studio copy test.) The k-floor is a privacy floor, not a cosmetic one.
    for (const label of [en.mRetentionD30, en.mRecoveryRate]) {
      const row = screen.getByText(label).closest('tr');
      expect(row).not.toBeNull();
      expect(within(row!).getByText(en.withheld)).toBeTruthy();
      // Anchored: the metric NAME "Recovery within 7 days" legitimately contains
      // "7 days"; a rendered value is a cell whose whole text is the number.
      expect(within(row!).queryByText(/^\d+(\.\d+)?%$|^\d+ days?$/)).toBeNull();
    }
    // The withheld rows still state how many contributed (3 and 4), so the reader
    // sees WHY without a value being implied.
    expect(screen.getByText('3 participants')).toBeTruthy();
    expect(screen.getByText('4 participants')).toBeTruthy();
    // A shown rate renders as a percentage next to its denominator.
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getAllByText('30 participants').length).toBeGreaterThanOrEqual(4);
    // The day metric formats as days; counts stay bare.
    expect(screen.getByText('2 days')).toBeTruthy();
    expect(screen.getByText('30 enrolments started')).toBeTruthy();
  });

  it('loads once per read (one batched load, not four sequential fetches)', async () => {
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(en.mNorthStar)).toBeTruthy());
    for (const fn of [getActivation, getEngagement, getFactory, getVerifierQuality]) expect(vi.mocked(fn)).toHaveBeenCalledTimes(1);
  });

  it('the verifier section refuses to invent a rate when nothing has been graded, and shows chips once it has', async () => {
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(en.verifierUngraded)).toBeTruthy());
    cleanup();
    state.verifier = { sampled: 10, resolved: 8, agreed: 6, falsePositives: 1, falseNegatives: 1, disagreementRate: 0.25 };
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText('Agreed: 6')).toBeTruthy());
    expect(screen.queryByText(en.verifierUngraded)).toBeNull();
  });

  it('a failed read is an honest error, never an empty table passed off as "nothing to measure"', async () => {
    state.fail = true;
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(en.loadError)).toBeTruthy());
    expect(screen.queryByText(en.emptyTitle)).toBeNull();
    expect(screen.queryByText(en.withheld)).toBeNull();
  });
});
