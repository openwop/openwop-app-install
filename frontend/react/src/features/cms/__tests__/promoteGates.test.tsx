/**
 * ADR 0950 P0 — the CMS manual promote shows the promotion gates in its confirm.
 * They warn and do not block: a red G2 is listed with its numbers, the warning is
 * shown, and confirming still promotes the chosen variant. An all-pass report does
 * not warn, a declined confirm promotes nothing, and an unreadable checklist says so
 * instead of hiding.
 *
 * Sabotage (w76 probes): dropping the checklist or its reason from the confirm body
 * reds the first case; making a failing checklist cancel the promote reds it too;
 * promoting another variant reds both promote cases; always warning reds the all-pass
 * case; ignoring the confirm's answer reds the declined case.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { t } from 'i18next';
import type { ExperimentResults, PageExperiment, PromoteResult } from '../cmsClient.js';
import type { GateReport } from '../../experiments/GateChecklist.js';

const h = vi.hoisted(() => ({
  gates: vi.fn<typeof import('../cmsClient.js').experimentGates>(),
  promote: vi.fn<typeof import('../cmsClient.js').promoteExperiment>(),
  confirmBody: null as ReactNode,
  confirmResult: true,
}));
const RESULTS: ExperimentResults = { experimentId: 'x1', status: 'running', baselineKey: 'control', minSessionsPerVariant: 30, variants: [{ key: 'control', versionId: null, weight: 50, sessions: 2, conversions: 0, conversionRate: 0, zScore: null, significant: null, insufficientSample: true }, { key: 'B', versionId: 'v2', weight: 50, sessions: 1, conversions: 1, conversionRate: 1, zScore: null, significant: null, insufficientSample: true }], unattributed: { legacy: 0, dropped: 0 }, health: { srm: null, stopEarly: 'fixed_horizon_do_not_stop_early' } };
const EXP: PageExperiment = { experimentId: 'x1', pageId: 'p1', name: 'Hero test', status: 'running', createdAt: '2026-10-01T00:00:00.000Z', variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId: 'v2', weight: 50 }] };
vi.mock('../cmsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listExperiments: vi.fn(async () => [EXP]),
  experimentGates: h.gates,
  experimentResults: vi.fn(async () => RESULTS),
  promoteExperiment: h.promote,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async (opts: { body?: ReactNode }) => { h.confirmBody = opts.body; return h.confirmResult; }) }));

import { PageExperimentsPanel } from '../PageExperimentsPanel.js';

const SNAPSHOT: GateReport['snapshot'] = { planHash: null, cellsHash: 'c'.repeat(64), computedAt: '2026-10-20T00:00:00.000Z' };
const RED_G2: GateReport = {
  experimentId: 'x1', winner: null, allPass: false, snapshot: SNAPSHOT,
  gates: [
    { id: 'G1', status: 'fail', reason: 'legacy_experiment', value: {} },
    { id: 'G2', status: 'fail', reason: 'too_short_and_below_sample', value: { days: 0, minDays: 7, smallestArm: 1, minSamplePerArm: 30 } },
    { id: 'G3', status: 'pass', value: {} },
  ],
};
const ALL_PASS: GateReport = {
  experimentId: 'x1', winner: 'B', allPass: true, snapshot: SNAPSHOT,
  gates: [{ id: 'G1', status: 'pass', value: {} }, { id: 'G2', status: 'pass', value: {} }, { id: 'G3', status: 'pass', value: {} }],
};
const PROMOTED: PromoteResult = { experiment: { ...EXP, status: 'promoted' }, pendingApproval: false, page: null };

async function clickPromote(): Promise<HTMLElement> {
  const { container } = render(<PageExperimentsPanel orgId="o1" pageId="p1" versions={[]} onLoadVersions={() => {}} onPageChanged={() => {}} />);
  const details = container.querySelector('details');
  if (!details) throw new Error('no details');
  details.open = true;
  fireEvent(details, new Event('toggle'));
  fireEvent.click(await screen.findByRole('button', { name: t('cms:expResultsShow') }));
  const buttons = await screen.findAllByRole('button', { name: t('cms:expPromote') });
  const promoteB = buttons[buttons.length - 1]!;
  fireEvent.click(promoteB);
  return promoteB;
}

afterEach(() => { cleanup(); h.gates.mockReset(); h.promote.mockReset(); h.confirmBody = null; h.confirmResult = true; });

describe('ADR 0950 P0 — the CMS promote confirm shows the gates', () => {
  it('a red G2 shows its numbers, warns, and still promotes', async () => {
    h.gates.mockResolvedValue(RED_G2);
    h.promote.mockResolvedValue(PROMOTED);
    await clickPromote();
    await waitFor(() => expect(h.promote).toHaveBeenCalledWith('o1', 'p1', 'x1', 'B'));
    render(<>{h.confirmBody}</>);
    expect(screen.getByText(t('experiments:gate_G2'))).toBeTruthy();
    expect(screen.getByText(/0 of 7 days, and the smallest variant has 1 of 30 visitors/)).toBeTruthy();
    expect(screen.getAllByText(t('experiments:gateStatus_fail')).length).toBe(2);
    expect(screen.getByText(t('cms:expGatesWarn'))).toBeTruthy();
  });

  it('an unreadable checklist says so, and the promote still goes ahead', async () => {
    h.gates.mockRejectedValue(new Error('down'));
    h.promote.mockResolvedValue(PROMOTED);
    await clickPromote();
    await waitFor(() => expect(h.promote).toHaveBeenCalledWith('o1', 'p1', 'x1', 'B'));
    render(<>{h.confirmBody}</>);
    expect(screen.getByText(t('cms:expGatesUnavailable'))).toBeTruthy();
  });

  it('an all-pass checklist shows no warning', async () => {
    h.gates.mockResolvedValue(ALL_PASS);
    h.promote.mockResolvedValue(PROMOTED);
    await clickPromote();
    await waitFor(() => expect(h.promote).toHaveBeenCalledWith('o1', 'p1', 'x1', 'B'));
    render(<>{h.confirmBody}</>);
    expect(screen.getAllByText(t('experiments:gateStatus_pass')).length).toBe(3);
    expect(screen.queryByText(t('cms:expGatesWarn'))).toBeNull();
  });

  it('a declined confirm promotes nothing', async () => {
    h.confirmResult = false;
    h.gates.mockResolvedValue(RED_G2);
    h.promote.mockResolvedValue(PROMOTED);
    const promoteB = await clickPromote();
    await waitFor(() => expect(h.confirmBody).not.toBeNull());
    // The row's busy flag clears only once the whole promote action has returned.
    await waitFor(() => expect(promoteB).toHaveProperty('disabled', false));
    expect(h.promote).not.toHaveBeenCalled();
  });
});
