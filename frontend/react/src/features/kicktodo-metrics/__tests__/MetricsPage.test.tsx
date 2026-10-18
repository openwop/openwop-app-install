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
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { messages as commonEn } from '../../../i18n/locales/en/common.js';
import type { ActivationMetrics, EngagementMetrics, FactoryMetrics, VerifierQuality } from '../../../client/kicktodoMetricsClient.js';

interface MetricsState {
  activation: ActivationMetrics;
  engagement: EngagementMetrics;
  factory: FactoryMetrics;
  verifier: VerifierQuality;
  fail: boolean;
  /** When set, getActivation waits on this promise (the batching case). */
  holdActivation: Promise<void> | null;
}

const UNGRADED: VerifierQuality = { sampled: 0, resolved: 0, agreed: 0, falsePositives: 0, falseNegatives: 0, disagreementRate: null };

const state: MetricsState = {
  activation: {
    daysToFirstCompletedActionP50: { value: 2, contributors: 12 },
    enrollmentsStarted: 30,
    enrollmentsWithAnyCompletion: { value: 18, contributors: 30 },
  },
  engagement: {
    weeklyMeaningfulProgress: { value: 9, contributors: 30 },
    retentionD7: { value: 0.5, contributors: 30 },
    retentionD30: { value: null, contributors: 3, withheldReason: 'below-k-floor' },
    completionRate: { value: 0.25, contributors: 30 },
    abandonmentRate: { value: 0.1, contributors: 30 },
    recoveryRate7d: { value: null, contributors: 4, withheldReason: 'below-k-floor' },
  },
  factory: { candidatesByState: { planned: 2, published: 3 }, publishRate: { value: 0.6, contributors: 5 } },
  verifier: { ...UNGRADED },
  fail: false,
  holdActivation: null,
};

vi.mock('../../../client/kicktodoMetricsClient.js', () => ({
  // A failed read throws, as the real client's `get` does on a non-2xx.
  getActivation: vi.fn(async () => {
    if (state.holdActivation) await state.holdActivation;
    if (state.fail) throw new Error('metrics request failed: 503');
    return state.activation;
  }),
  getEngagement: vi.fn(async () => state.engagement),
  getFactory: vi.fn(async () => state.factory),
  getVerifierQuality: vi.fn(async () => state.verifier),
}));

import { MetricsPage } from '../MetricsPage.js';
import { getActivation, getEngagement, getFactory, getVerifierQuality } from '../../../client/kicktodoMetricsClient.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => {
  cleanup();
  state.fail = false;
  state.holdActivation = null;
  state.verifier = { ...UNGRADED }; // case 3 replaces it; never leak across cases
  vi.clearAllMocks();
});

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
    // Hold the FIRST read open: a batched load has already issued the other three;
    // a sequential one would still be waiting on activation.
    let release!: () => void;
    state.holdActivation = new Promise<void>((r) => { release = r; });
    render(<MetricsPage />);
    await waitFor(() => expect(vi.mocked(getActivation)).toHaveBeenCalledTimes(1));
    for (const fn of [getEngagement, getFactory, getVerifierQuality]) expect(vi.mocked(fn)).toHaveBeenCalledTimes(1);
    release();
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

  // CS-4 — the failure offers its way back. Breaks it: dropping the Retry button,
  // or a Retry that does not re-run the batched read (sabotage-witnessed: the
  // onClick reduced to a no-op turns this red at the table assertion).
  it('a failed read offers Retry, which re-runs the load and shows the tables', async () => {
    state.fail = true;
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(en.loadError)).toBeTruthy());
    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: commonEn.retry }));
    await waitFor(() => expect(screen.getByText(en.mPublishRate)).toBeTruthy());
    expect(screen.queryByText(en.loadError)).toBeNull();
  });
});
