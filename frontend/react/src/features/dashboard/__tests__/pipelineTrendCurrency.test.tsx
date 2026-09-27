/**
 * R3 (CRM console XCC-6 recorded follow-up) — the pipeline trend tile summed
 * snapshot weightedSum currency-BLIND with no caveat while ReportsTab got the
 * CC-SP-3 honesty pass. Pins the tile's three currency postures:
 *  - one currency  → the stat formats IN it, no caveat;
 *  - mixed         → unitless number + the DISCLOSED mix;
 *  - none reported → unchanged unitless render (older wire / unitless deals).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';

const getPipelineReport = vi.fn();
vi.mock('../../crm/crmReportsClient.js', () => ({
  getPipelineReport: (...a: unknown[]) => getPipelineReport(...a),
}));
vi.mock('../useDashboardOrg.js', () => ({
  useDashboardOrg: () => ({ orgId: 'o1', loading: false, error: false }),
}));

import PipelineTrendTile from '../tiles/PipelineTrendTile.js';
import { __resetSharedReads } from '../sharedRead.js';

const snap = (week: string, weighted: number) => ({
  isoWeek: week, at: `${week}T00:00:00Z`,
  perStage: [{ stageId: 's1', name: 'Open', probability: 0.5, count: 2, sum: weighted * 2, weightedSum: weighted }],
});

const report = (currencies: string[] | undefined) => ({
  funnel: [], perStage: [], totals: { openCount: 0, wonCount: 0, lostCount: 0, winRate: null },
  aging: [], conversions: [],
  snapshots: [snap('2026-W31', 1000), snap('2026-W32', 1500)],
  ...(currencies ? { currencies } : {}),
});

afterEach(() => { cleanup(); vi.clearAllMocks(); __resetSharedReads(); });

const mount = async (): Promise<void> => {
  render(<PipelineTrendTile compact={false} />);
  await act(async () => {});
};

describe('pipeline trend tile — currency honesty', () => {
  it('ONE currency: the stat is currency-formatted and no caveat renders', async () => {
    getPipelineReport.mockResolvedValue(report(['EUR']));
    await mount();
    expect(screen.getByText(/€\s?1[.,]500|1[.,]500\s?€/)).toBeTruthy();
    expect(screen.queryByText(/mixed currencies/i)).toBeNull();
  });

  it('MIXED currencies: unitless number + the disclosed mix (the recorded follow-up)', async () => {
    getPipelineReport.mockResolvedValue(report(['USD', 'EUR']));
    await mount();
    expect(screen.getByText(/mixed currencies \(USD, EUR\)/i)).toBeTruthy();
    expect(screen.queryByText(/\$\s?1,500/)).toBeNull(); // never a false single unit
  });

  it('NO currencies field (older wire): unchanged unitless render, no caveat', async () => {
    getPipelineReport.mockResolvedValue(report(undefined));
    await mount();
    expect(screen.getByText('1,500')).toBeTruthy();
    expect(screen.queryByText(/mixed currencies/i)).toBeNull();
  });
});
