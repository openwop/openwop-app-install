/**
 * UX_UPGRADE-kicktodo-admin P2 — a content-health console must not fabricate.
 *
 * UX-KTA-2: `reload()` did `Promise.all([getFactory().catch(() => null),
 * listChallenges().catch(() => [])])`. The `[]` fallback feeds `countByState([])`,
 * i.e. a full set of ZERO counts, and `null` blanks the candidate pipeline. This
 * file's docstring commits to the opposite in as many words:
 *   "Honesty: a FlooredCell withheld below the k-anonymity floor renders as
 *    'withheld', never a fabricated number (§3.4 metric trustworthiness)."
 * The k-anonymity floor was honoured while the failure path quietly invented
 * zeros — and "No published challenges yet." is exactly the fabricated claim an
 * operator would act on.
 *
 * UX-KTA-3, and worse: because BOTH reads caught internally, `Promise.all` could
 * never reject, so the outer `catch { setError(true) }` was UNREACHABLE. `error`
 * was permanently false and the KTUX-18 error Notice + retry below it was dead
 * code that could not render — while its own comment promised "a reusable load so
 * the error state can offer a retry".
 *
 * Both arms asserted: a failed read says unknown and surfaces the retry, and a
 * genuinely empty catalog still says empty.
 *
 * Sabotage witnesses (w40 probes): mapping a failed catalog read to `[]`, an
 * error flag that ignores the factory read, an always-on error, gating the
 * catalog on the factory read, or a no-op Retry each turn a case here red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { FactoryMetrics } from '../../../client/kicktodoMetricsClient.js';
import type { ChallengeSummary } from '../../../client/kicktodoClient.js';

const metrics = vi.hoisted(() => ({ getFactory: vi.fn<() => Promise<FactoryMetrics>>() }));
vi.mock('../../../client/kicktodoMetricsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getFactory: metrics.getFactory };
});

const kt = vi.hoisted(() => ({ listChallenges: vi.fn<() => Promise<ChallengeSummary[]>>() }));
vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listChallenges: kt.listChallenges };
});

import { CatalogHealthPage } from '../CatalogHealthPage.js';

const FACTORY: FactoryMetrics = { candidatesByState: { intake: 2 }, publishRate: { value: 1, contributors: 5 } };

function view(): void {
  render(<MemoryRouter><CatalogHealthPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  metrics.getFactory.mockResolvedValue(FACTORY);
  kt.listChallenges.mockResolvedValue([]);
});
afterEach(cleanup);

describe('UX-KTA-2 — an unread catalog never reports zero', () => {
  it('FAILURE: says the catalog could not be read, NOT "No published challenges yet."', async () => {
    kt.listChallenges.mockRejectedValue(new Error('challenges_500'));
    view();
    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No published challenges yet/i)).toBeNull();
  });

  it('EMPTY: a genuinely empty catalog still says so', async () => {
    // The other arm — without it, "always unknown" would pass the test above
    // while destroying the accurate all-clear.
    kt.listChallenges.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No published challenges yet/i)).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });
});

describe('UX-KTA-3 — the error + retry state is reachable at all', () => {
  it('FAILURE: the error Notice renders (it previously could not)', async () => {
    // `setError(true)` sat in an outer catch that the inner `.catch`es made
    // unreachable, so this Notice was dead code.
    metrics.getFactory.mockRejectedValue(new Error('factory_500'));
    view();
    expect(await screen.findByText(/Could not load content health/i)).toBeTruthy();
    // …and its Retry actually re-reads and clears the error once the read heals.
    metrics.getFactory.mockResolvedValue(FACTORY);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Could not load content health/i)).toBeNull());
    expect(metrics.getFactory).toHaveBeenCalledTimes(2);
  });

  it('SUCCESS: no error Notice when both reads succeed', async () => {
    view();
    await screen.findByText(/No published challenges yet/i);
    expect(screen.queryByText(/Could not load content health/i)).toBeNull();
  });

  it('a factory failure does not blank the challenges it DID read', async () => {
    metrics.getFactory.mockRejectedValue(new Error('factory_500'));
    kt.listChallenges.mockResolvedValue([]);
    view();
    await screen.findByText(/Could not load content health/i);
    // allSettled: the successful read still renders its real empty state.
    expect(screen.getByText(/No published challenges yet/i)).toBeTruthy();
  });
});
