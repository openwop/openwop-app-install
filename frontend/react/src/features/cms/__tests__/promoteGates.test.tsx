/**
 * ADR 0950 P0 — the CMS manual promote shows the promotion gates in its confirm.
 * They warn and do not block: a red G2 (3 sessions) is listed with its numbers,
 * the warning is shown, and confirming still promotes. An unreadable checklist
 * says so instead of hiding.
 *
 * Sabotage (run 2026-10-20): dropping the checklist from the confirm body reds
 * the first case; making a failing checklist cancel the promote reds it too.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { PageExperiment } from '../cmsClient.js';
import type { GateReport } from '../../experiments/GateChecklist.js';

const h = vi.hoisted(() => ({ gates: vi.fn(), promote: vi.fn(), confirmBody: null as unknown }));
const RESULTS = { experimentId: 'x1', status: 'running', baselineKey: 'control', minSessionsPerVariant: 30, variants: [{ key: 'control', versionId: null, weight: 50, sessions: 2, conversions: 0, conversionRate: 0, zScore: null, significant: null, insufficientSample: true }, { key: 'B', versionId: 'v2', weight: 50, sessions: 1, conversions: 1, conversionRate: 1, zScore: null, significant: null, insufficientSample: true }], unattributed: { legacy: 0, dropped: 0 }, health: { srm: null, stopEarly: 'fixed_horizon_do_not_stop_early' } };
const EXP: PageExperiment = { experimentId: 'x1', pageId: 'p1', name: 'Hero test', status: 'running', createdAt: '2026-10-01T00:00:00.000Z', variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId: 'v2', weight: 50 }] };
vi.mock('../cmsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listExperiments: vi.fn(async () => [EXP]),
  experimentGates: h.gates,
  experimentResults: vi.fn(async () => RESULTS),
  promoteExperiment: h.promote,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async (opts: { body?: unknown }) => { h.confirmBody = opts.body; return true; }) }));

import { PageExperimentsPanel } from '../PageExperimentsPanel.js';

const RED_G2: GateReport = {
  experimentId: 'x1', winner: null, allPass: false, snapshot: { planHash: null, cellsHash: 'c'.repeat(64), computedAt: '2026-10-20T00:00:00.000Z' },
  gates: [
    { id: 'G1', status: 'fail', reason: 'legacy_experiment', value: {} },
    { id: 'G2', status: 'fail', reason: 'too_short_and_below_sample', value: { days: 0, minDays: 7, smallestArm: 1, minSamplePerArm: 30 } },
    { id: 'G3', status: 'pass', value: {} },
  ],
};

async function clickPromote(): Promise<void> {
  const { container } = render(<PageExperimentsPanel orgId="o1" pageId="p1" versions={[]} onLoadVersions={() => {}} onPageChanged={() => {}} />);
  const details = container.querySelector('details');
  if (!details) throw new Error('no details');
  details.open = true;
  fireEvent(details, new Event('toggle'));
  fireEvent.click(await screen.findByRole('button', { name: 'Results' }));
  const buttons = await screen.findAllByRole('button', { name: 'Promote' });
  fireEvent.click(buttons[buttons.length - 1]!);
}

afterEach(() => { cleanup(); h.gates.mockReset(); h.promote.mockReset(); h.confirmBody = null; });

describe('ADR 0950 P0 — the CMS promote confirm shows the gates', () => {
  it('a 3-session arm shows a red G2 with its numbers, warns, and still promotes', async () => {
    h.gates.mockResolvedValue(RED_G2);
    h.promote.mockResolvedValue({ experiment: { ...EXP, status: 'promoted' }, pendingApproval: false });
    await clickPromote();
    await waitFor(() => expect(h.promote).toHaveBeenCalled());
    render(<>{h.confirmBody as JSX.Element}</>);
    expect(screen.getByText('Ran long enough, with enough visitors')).toBeTruthy();
    expect(screen.getByText(/0 of 7 days, and the smallest variant has 1 of 30 visitors/)).toBeTruthy();
    expect(screen.getAllByText('Fails').length).toBe(2);
    expect(screen.getByText(/You can still promote by hand/)).toBeTruthy();
  });

  it('an unreadable checklist says so, and the promote still goes ahead', async () => {
    h.gates.mockRejectedValue(new Error('down'));
    h.promote.mockResolvedValue({ experiment: { ...EXP, status: 'promoted' }, pendingApproval: false });
    await clickPromote();
    await waitFor(() => expect(h.promote).toHaveBeenCalled());
    render(<>{h.confirmBody as JSX.Element}</>);
    expect(screen.getByText(/promotion checks could not be read/)).toBeTruthy();
  });
});
