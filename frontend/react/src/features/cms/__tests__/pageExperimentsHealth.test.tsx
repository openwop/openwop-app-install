/**
 * ADR 0949 P0 — the legacy CMS A/B result says when its verdict cannot be trusted.
 *
 *   - a broken traffic split (SRM) shows the warning and withholds the z-score;
 *   - every result carries the standing "fixed-horizon, do not stop early" note;
 *   - a healthy result still shows its z-score and its chip, which is what makes
 *     their absence in the SRM case mean something.
 *
 * The missing "significant" chip under SRM is the SERVER's guarantee:
 * `host/experiments/legacyProjection.ts` nulls every `significant` on a broken split
 * (`adr0949-legacy-health.test.ts`). This page has no guard of its own, so this file
 * proves only that a null `significant` draws no chip.
 *
 * Sabotage (w76 probes): dropping the `significanceWithheld` Notice or its z-score
 * check reds the SRM case; always drawing the chip reds it too; dropping the
 * stop-early line reds both; never drawing z or the chip reds the healthy case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { t } from 'i18next';
import type { ExperimentResults, ExperimentVariantResult, PageExperiment } from '../cmsClient.js';

const h = vi.hoisted(() => ({ results: vi.fn() }));
const EXP: PageExperiment = { experimentId: 'x1', pageId: 'p1', name: 'Hero test', status: 'running', createdAt: '2026-10-01T00:00:00.000Z', variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId: 'v2', weight: 50 }] };
vi.mock('../cmsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listExperiments: vi.fn(async () => [EXP]),
  experimentResults: h.results,
}));

import { PageExperimentsPanel } from '../PageExperimentsPanel.js';

const CONTROL: ExperimentVariantResult = { key: 'control', versionId: null, weight: 50, sessions: 300, conversions: 30, conversionRate: 0.1, zScore: null, significant: null, insufficientSample: false };
const VARIANT_B: ExperimentVariantResult = { key: 'B', versionId: 'v2', weight: 50, sessions: 100, conversions: 40, conversionRate: 0.4, zScore: 6.2, significant: null, insufficientSample: false };

const base = (over: Partial<ExperimentResults>): ExperimentResults => ({
  experimentId: 'x1', status: 'running', baselineKey: 'control', minSessionsPerVariant: 30,
  variants: [CONTROL, VARIANT_B],
  health: { srm: { chiSquare: 100, pValue: 1e-23, mismatch: true, alpha: 0.001 }, stopEarly: 'fixed_horizon_do_not_stop_early' },
  ...over,
});

async function openResults(): Promise<void> {
  const { container } = render(<PageExperimentsPanel orgId="o1" pageId="p1" versions={[]} onLoadVersions={() => {}} onPageChanged={() => {}} />);
  const details = container.querySelector('details');
  if (!details) throw new Error('no details');
  details.open = true;
  fireEvent(details, new Event('toggle'));
  fireEvent.click(await screen.findByRole('button', { name: t('cms:expResultsShow') }));
}

afterEach(() => { cleanup(); h.results.mockReset(); });

describe('ADR 0949 P0 — legacy CMS result honesty', () => {
  it('a broken split shows the SRM warning and no significant chip', async () => {
    h.results.mockResolvedValue(base({ significanceWithheld: 'srm' }));
    await openResults();
    expect(await screen.findByText(t('cms:expSrmNotice'))).toBeTruthy();
    expect(screen.queryByText(t('cms:expSignificantChip'))).toBeNull();
    expect(screen.queryByText(/z 6\.2/)).toBeNull(); // the z-score is withheld with the verdict
    expect(screen.getByText(t('cms:expStopEarlyNote'))).toBeTruthy();
  });

  it('a healthy result still carries the stop-early note', async () => {
    h.results.mockResolvedValue(base({
      variants: [{ ...CONTROL, sessions: 200, conversions: 20 }, { ...VARIANT_B, sessions: 200, conversions: 80, zScore: 6.9, significant: true }],
      health: { srm: { chiSquare: 0, pValue: 1, mismatch: false, alpha: 0.001 }, stopEarly: 'fixed_horizon_do_not_stop_early' },
    }));
    await openResults();
    expect(await screen.findByText(t('cms:expStopEarlyNote'))).toBeTruthy();
    expect(screen.queryByText(t('cms:expSrmNotice'))).toBeNull();
    // The positive control for both absences above.
    expect(screen.getByText(t('cms:expSignificantChip'))).toBeTruthy();
    expect(screen.getByText(/z 6\.9/)).toBeTruthy();
  });
});
