/**
 * ADR 0949 P2b — the experiment page speaks Decide, not "significant":
 *   1. a draft shows the live sample size, offers no Launch, and tells an outage from
 *      bad input in both directions;
 *   2. a locked draft shows the locked sample size and launches only after a
 *      confirm;
 *   3. an SRM halt shows the halt warning and the verdict, and no page ever
 *      renders the word "significant";
 *   4. a legacy test is read-only here.
 *
 * Sabotage (w76 probes): ignoring the launch confirm reds 2; showing `sampleInvalid`
 * for every failure, or `sampleFailed` for every failure, reds 1; offering Launch on an
 * unlocked draft reds 1; dropping the SRM Notice reds 3.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { t } from 'i18next';
import type * as EC from '../experimentsClient.js';
import type { DecideResults, Experiment } from '../experimentsClient.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const confirmMock = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../ui/confirm.js', () => confirmMock);

const api = vi.hoisted(() => ({
  getExperiment: vi.fn<typeof EC.getExperiment>(),
  getResults: vi.fn<typeof EC.getResults>(),
  powerCalc: vi.fn<typeof EC.powerCalc>(),
  transition: vi.fn<typeof EC.transition>(),
  lockPlan: vi.fn<typeof EC.lockPlan>(),
  updateExperiment: vi.fn<typeof EC.updateExperiment>(),
  deleteExperiment: vi.fn<typeof EC.deleteExperiment>(),
  reallocate: vi.fn<typeof EC.reallocate>(),
  getGates: vi.fn<typeof EC.getGates>(),
}));
vi.mock('../experimentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

const cms = vi.hoisted(() => ({ listVersions: vi.fn(async () => [{ versionId: 'v2', version: 3, snapshot: { title: 'Short hero', slug: 's', sections: [] }, publishedAt: '', publishedBy: '' }]), listPages: vi.fn(async () => []) }));
vi.mock('../../cms/cmsClient.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...cms }));

const { ExperimentDetailPage } = await import('../ExperimentDetailPage.js');
const { ExperimentsRequestError } = await import('../experimentsClient.js');

const PLAN = { primaryMetric: { kind: 'conversion' as const, name: 'signup' }, guardrails: [] as [], baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 30 };
const EXP = (over: Partial<Experiment> = {}): Experiment => ({
  experimentId: 'exp:1', orgId: 'o1', name: 'Hero test', hypothesis: 'Shorter wins',
  surface: { kind: 'cms.page', ref: 'p1' },
  arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: 'v2', weight: 50 }],
  mode: 'decide', status: 'draft', epochs: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const RESULTS = (over: Partial<DecideResults> = {}): DecideResults => ({
  experimentId: 'exp:1', status: 'running', mode: 'decide', planHash: 'h',
  verdict: { kind: 'srm_halt' },
  arms: [{ key: 'control', units: 300, conversions: 30, rate: 0.1 }, { key: 'b', units: 100, conversions: 10, rate: 0.1, delta: 0, confidenceSequence: [-0.05, 0.05], pValue: 1, qValue: 1 }],
  srm: { chiSquare: 100, pValue: 1e-23, mismatch: true, alpha: 0.001 },
  gates: { minDays: 7, daysElapsed: 2, minSamplePerArm: 3841, smallestArm: 100, met: false },
  coverage: { status: 'complete', retainedSince: null },
  computedAt: '2026-10-03T00:00:00.000Z',
  ...over,
});

const view = (): void => {
  render(
    <MemoryRouter initialEntries={['/experiments/exp%3A1?org=o1']}>
      <Routes><Route path="/experiments/:experimentId" element={<ExperimentDetailPage />} /></Routes>
    </MemoryRouter>,
  );
};
/** The live sample size is debounced 300 ms: step past it instead of waiting for it. */
const passDebounce = (): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(300); });

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.powerCalc.mockResolvedValue(3841);
  api.getGates.mockRejectedValue(new Error('not stubbed in this case'));
});
afterEach(cleanup);

describe('ADR 0949 P2b — experiment page', () => {
  it('a draft shows the live sample size; an outage is not reported as bad input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      api.getExperiment.mockResolvedValue(EXP({ planDraft: PLAN }));
      view();
      const minDays = await screen.findByLabelText(/Minimum days/);
      await passDebounce();
      expect(await screen.findByText(t('experiments:sampleNeeded', { n: '3,841' }))).toBeTruthy();
      expect(api.powerCalc).toHaveBeenCalledWith('o1', { baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8 });
      expect(screen.queryByRole('button', { name: t('experiments:launch') })).toBeNull(); // nothing is locked yet

      api.powerCalc.mockRejectedValue(new ExperimentsRequestError('down', 503));
      fireEvent.change(minDays, { target: { value: '8' } });
      await passDebounce();
      expect(await screen.findByText(t('experiments:sampleFailed'))).toBeTruthy();
      expect(screen.queryByText(t('experiments:sampleInvalid'))).toBeNull();

      api.powerCalc.mockRejectedValue(new ExperimentsRequestError('bad', 400));
      fireEvent.change(minDays, { target: { value: '9' } });
      await passDebounce();
      expect(await screen.findByText(t('experiments:sampleInvalid'))).toBeTruthy();
      expect(screen.queryByText(t('experiments:sampleFailed'))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a locked draft launches only after a confirm', async () => {
    api.getExperiment.mockResolvedValue(EXP({ plan: { ...PLAN, minSamplePerArm: 3841, lockedAt: '2026-10-02T00:00:00.000Z', planHash: 'h' } }));
    api.transition.mockResolvedValue(EXP({ status: 'running' }));
    confirmMock.confirm.mockResolvedValueOnce(false);
    view();
    expect(await screen.findByText(t('experiments:sampleLocked', { n: '3,841' }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('experiments:launch') }));
    await waitFor(() => expect(confirmMock.confirm).toHaveBeenCalledTimes(1));
    expect(api.transition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('experiments:launch') }));
    await waitFor(() => expect(api.transition).toHaveBeenCalledWith('o1', 'exp:1', 'launch'));
  });

  it('an SRM halt shows the warning and the verdict, never "significant"', async () => {
    api.getExperiment.mockResolvedValue(EXP({ status: 'running', startedAt: '2026-10-02T00:00:00.000Z', plan: { ...PLAN, minSamplePerArm: 3841, lockedAt: '2026-10-02T00:00:00.000Z', planHash: 'h' } }));
    api.getResults.mockResolvedValue(RESULTS());
    view();
    expect(await screen.findByText(t('experiments:srmHaltNotice'))).toBeTruthy();
    expect(screen.getByText(t('experiments:verdict_srm_halt'))).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/significan/i);
  });

  it('ux-review: arms name their content, running reads as an accent chip, results refresh', async () => {
    api.getExperiment.mockResolvedValue(EXP({ status: 'running', startedAt: '2026-10-02T00:00:00.000Z', plan: { ...PLAN, minSamplePerArm: 3841, lockedAt: '2026-10-02T00:00:00.000Z', planHash: 'h' } }));
    api.getResults.mockResolvedValue(RESULTS({ verdict: { kind: 'running' }, srm: null }));
    view();
    expect(await screen.findByText('Version 3: Short hero')).toBeTruthy();
    // DESIGN.md §5.3 names the tone per status; the class is the claim here.
    expect(screen.getByText(t('experiments:status_running')).className).toContain('chip--accent');
    fireEvent.click(screen.getByRole('button', { name: t('experiments:refreshResults') }));
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(2));
  });

  it('a legacy test is read-only here', async () => {
    api.getExperiment.mockResolvedValue(EXP({ legacy: true, status: 'running', startedAt: '2026-10-02T00:00:00.000Z' }));
    view();
    expect(await screen.findByText(t('experiments:legacyNotice'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('experiments:stop') })).toBeNull();
    expect(screen.queryByRole('form', { name: t('experiments:planTitle') })).toBeNull();
    expect(api.getResults).not.toHaveBeenCalled();
  });

  it('ADR 0949 P4b — an Optimize experiment shows estimates, never a verdict, launches without a plan, and rebalances on demand', async () => {
    const optimize = { rewardMetric: { kind: 'conversion' as const, name: 'signup' }, floorPct: 5, epochMinutes: 1440 };
    api.getExperiment.mockResolvedValue(EXP({ mode: 'optimize', optimize, status: 'running', startedAt: '2026-10-02T00:00:00.000Z' }));
    api.getResults.mockResolvedValue({
      experimentId: 'exp:1', status: 'running', mode: 'optimize', epoch: 2, weights: { control: 20, b: 80 },
      arms: [{ key: 'control', units: 400, conversions: 20, rate: 0.05, probabilityBest: 0.01, expectedLoss: 0.08 }, { key: 'b', units: 400, conversions: 60, rate: 0.15, probabilityBest: 0.99, expectedLoss: 0.0001 }],
      floorPct: 5, stickinessCapped: false, coverage: { status: 'complete', retainedSince: null }, computedAt: '2026-10-03T00:00:00.000Z',
    });
    api.reallocate.mockResolvedValue({ outcome: 'too_soon', epoch: 2 });
    view();
    expect(await screen.findByText(t('experiments:colProbabilityBest'))).toBeTruthy();
    expect(screen.getByText(/never declares a winner/)).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/Verdict|significan|wins\./i);
    expect(screen.queryByRole('form', { name: t('experiments:planTitle') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rebalance now' }));
    await waitFor(() => expect(api.reallocate).toHaveBeenCalledWith('o1', 'exp:1'));
  });

  it('ADR 0949 P4b — an Optimize draft with settings can launch without a plan', async () => {
    api.getExperiment.mockResolvedValue(EXP({ mode: 'optimize', optimize: { rewardMetric: { kind: 'conversion', name: 'c' }, floorPct: 5, epochMinutes: 60 } }));
    view();
    expect(await screen.findByRole('button', { name: t('experiments:launch') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('experiments:lockPlan') })).toBeNull();
  });

  it('ADR 0950 P0 — a running Decide experiment shows its promotion checks', async () => {
    api.getExperiment.mockResolvedValue(EXP({ status: 'running', startedAt: '2026-10-02T00:00:00.000Z', plan: { ...PLAN, minSamplePerArm: 3841, lockedAt: '2026-10-02T00:00:00.000Z', planHash: 'h' } }));
    api.getResults.mockResolvedValue(RESULTS({ verdict: { kind: 'running' }, srm: null }));
    api.getGates.mockResolvedValue({ experimentId: 'exp:1', winner: null, allPass: false, snapshot: { planHash: 'h', cellsHash: 'c', computedAt: '2026-10-03T00:00:00.000Z' },
      gates: [{ id: 'G1', status: 'pass', value: {} }, { id: 'G2', status: 'fail', reason: 'below_sample', value: { smallestArm: 100, minSamplePerArm: 3841 } }] });
    view();
    expect(await screen.findByText(t('experiments:gatesTitle'))).toBeTruthy();
    const list = within(screen.getByRole('list', { name: t('experiments:gatesTitle') }));
    const gateRow = (id: 'G1' | 'G2') => {
      const row = list.getByText(t(`experiments:gate_${id}`)).closest<HTMLElement>('li');
      if (!row) throw new Error('no gate row');
      return within(row);
    };
    expect(gateRow('G1').getByText(t('experiments:gateStatus_pass'))).toBeTruthy();
    expect(gateRow('G2').getByText(t('experiments:gateStatus_fail'))).toBeTruthy();
    expect(gateRow('G2').getByText(t('experiments:gateReason_below_sample', { smallest: '100', min: '3,841' }))).toBeTruthy();
  });
});
