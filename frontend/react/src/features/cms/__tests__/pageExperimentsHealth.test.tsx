/**
 * ADR 0949 P0 — the legacy CMS A/B result says when its verdict cannot be trusted.
 *
 *   - a broken traffic split (SRM) shows the warning, and no "significant" chip;
 *   - every result carries the standing "fixed-horizon, do not stop early" note.
 *
 * Sabotage (run 2026-10-20): dropping the `significanceWithheld` Notice reds the
 * SRM case; dropping the stop-early line reds both.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ExperimentResults, PageExperiment } from '../cmsClient.js';

const h = vi.hoisted(() => ({ results: vi.fn() }));
const EXP: PageExperiment = { experimentId: 'x1', pageId: 'p1', name: 'Hero test', status: 'running', createdAt: '2026-10-01T00:00:00.000Z', variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId: 'v2', weight: 50 }] };
vi.mock('../cmsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listExperiments: vi.fn(async () => [EXP]),
  experimentResults: h.results,
}));

import { PageExperimentsPanel } from '../PageExperimentsPanel.js';

const base = (over: Partial<ExperimentResults>): ExperimentResults => ({
  experimentId: 'x1', status: 'running', baselineKey: 'control', minSessionsPerVariant: 30,
  variants: [
    { key: 'control', versionId: null, weight: 50, sessions: 300, conversions: 30, conversionRate: 0.1, zScore: null, significant: null, insufficientSample: false },
    { key: 'B', versionId: 'v2', weight: 50, sessions: 100, conversions: 40, conversionRate: 0.4, zScore: 6.2, significant: null, insufficientSample: false },
  ],
  health: { srm: { chiSquare: 100, pValue: 1e-23, mismatch: true, alpha: 0.001 }, stopEarly: 'fixed_horizon_do_not_stop_early' },
  ...over,
});

async function openResults(): Promise<void> {
  const { container } = render(<PageExperimentsPanel orgId="o1" pageId="p1" versions={[]} onLoadVersions={() => {}} onPageChanged={() => {}} />);
  const details = container.querySelector('details');
  if (!details) throw new Error('no details');
  details.open = true;
  fireEvent(details, new Event('toggle'));
  fireEvent.click(await screen.findByRole('button', { name: 'Results' }));
}

afterEach(() => { cleanup(); h.results.mockReset(); });

describe('ADR 0949 P0 — legacy CMS result honesty', () => {
  it('a broken split shows the SRM warning and no significant chip', async () => {
    h.results.mockResolvedValue(base({ significanceWithheld: 'srm' }));
    await openResults();
    expect(await screen.findByText(/does not match the weights you set/)).toBeTruthy();
    expect(screen.queryByText(/significant at 95%/)).toBeNull();
    expect(screen.queryByText(/z 6\.2/)).toBeNull(); // the z-score is withheld with the verdict
    expect(screen.getByText(/assumes you read it once, at the end/)).toBeTruthy();
  });

  it('a healthy result still carries the stop-early note', async () => {
    h.results.mockResolvedValue(base({ health: { srm: { chiSquare: 0, pValue: 1, mismatch: false, alpha: 0.001 }, stopEarly: 'fixed_horizon_do_not_stop_early' } }));
    await openResults();
    expect(await screen.findByText(/assumes you read it once, at the end/)).toBeTruthy();
    expect(screen.queryByText(/does not match the weights you set/)).toBeNull();
  });
});
