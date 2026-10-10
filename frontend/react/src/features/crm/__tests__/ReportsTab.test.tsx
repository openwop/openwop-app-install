/**
 * ReportsTab (ADR 0210 §4 / C6) — the ONE `/reports/pipeline` fetch renders
 * the key-figure totals, the weighted-pipeline table, and the aging empty
 * state; asserts no fan-out (getPipelineReport called exactly once per
 * pipeline selection). Also CRM-UX-13 (a failed read is the canonical
 * announced card; ONE Retry re-reads both reads) and R2 CC-SP-3 (currency-
 * grouped sums, never a blind cross-currency total; the mixed-currency caveat
 * shows only for >1 currency).
 *
 * Sabotage that turns it red (wave-4 /grade-tests probes): the `pipelines ===
 * null` / `pipelinesFailed` report guard removed; Retry wired to the report
 * read only; the blind sum rendered; the caveat shown for one currency (this
 * leg was vacuous until wave 4 — it read the SKELETON of the second render)
 * or never.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PipelineReport } from '../crmReportsClient.js';
import type * as OrgClient from '../crmOrgClient.js';

const listPipelines = vi.hoisted(() => vi.fn<typeof OrgClient.listPipelines>(async () => [
  { pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] },
]));
vi.mock('../crmOrgClient.js', () => ({
  listPipelines,
}));

const getPipelineReport = vi.hoisted(() => vi.fn(async (): Promise<PipelineReport> => ({
  funnel: [{ stage: 'New', count: 30 }, { stage: 'Qualified', count: 15 }],
  perStage: [
    { stageId: 's1', name: 'New', probability: 10, count: 30, sum: 5000, weightedSum: 500 },
    { stageId: 's2', name: 'Qualified', probability: 40, count: 15, sum: 2000, weightedSum: 800 },
  ],
  totals: { openCount: 12, wonCount: 8, lostCount: 4, winRate: 0.6667 },
  aging: [],
  snapshots: [],
  conversions: [],
})));
vi.mock('../crmReportsClient.js', () => ({
  getPipelineReport,
}));

import { ReportsTab } from '../ReportsTab.js';

const renderTab = (orgId = 'o1') => render(<MemoryRouter><ReportsTab orgId={orgId} /></MemoryRouter>);

beforeEach(() => {
  // resetAllMocks restores each `vi.fn(impl)` default (Vitest 4) AND drops any
  // unconsumed `*Once` a failing case left behind.
  vi.resetAllMocks();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ReportsTab', () => {
  it('fetches the report exactly once and renders the key-figure totals', async () => {
    renderTab();
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledTimes(1));
    expect(getPipelineReport).toHaveBeenCalledWith('o1', 'p1');
    expect(await screen.findByText('12')).toBeTruthy(); // openCount
    expect(screen.getByText('8')).toBeTruthy(); // wonCount
    expect(screen.getByText('4')).toBeTruthy(); // lostCount
    expect(screen.getByText('67%')).toBeTruthy(); // winRate formatted
    // …and STILL exactly once after the report rendered (the waitFor above
    // passes the first instant the count is 1; a later re-fetch lands after it).
    expect(getPipelineReport).toHaveBeenCalledTimes(1);
  });

  it('renders the weighted-pipeline table rows', async () => {
    renderTab();
    const table = await screen.findByRole('table', { name: 'Weighted pipeline' });
    // Each stage row with its weighted figure (weightedSum 500 / 800).
    expect(within(table).getByText('New')).toBeTruthy();
    expect(within(table).getByText('Qualified')).toBeTruthy();
    expect(within(table).getByText('500')).toBeTruthy();
    expect(within(table).getByText('800')).toBeTruthy();
  });

  it('shows the aging empty state when aging is empty', async () => {
    renderTab();
    expect(await screen.findByText('Nothing at risk')).toBeTruthy();
  });

  // CRM-UX-13 — the shared announced card (the CRM-UX-4 bar every other CRM
  // surface met), NOT a bare Notice carrying the transport's string. These
  // used to assert `findByText('boom')` — pinning the defect.
  const FAILED_TITLE = 'Could not load this';
  const FAILED_BODY = 'The list could not be read, so we cannot say what is here. Retry, or reload the page.';

  it('a failed REPORT read is the canonical announced card — the transport\'s words never reach the user', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getPipelineReport.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
    expect(screen.getByText(FAILED_BODY)).toBeTruthy();
    expect(screen.queryByText('boom')).toBeNull();
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it('Retry re-reads BOTH the pipelines and the report (the old Retry re-ran only the report)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getPipelineReport.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    await screen.findByText(FAILED_TITLE);
    expect(listPipelines).toHaveBeenCalledTimes(1);
    expect(getPipelineReport).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listPipelines).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('12')).toBeTruthy(); // openCount, from the successful retry
    expect(screen.queryByText(FAILED_TITLE)).toBeNull();
  });

  it('a failed PIPELINES read is the same card, does NOT fire the report read, and Retry recovers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    listPipelines.mockRejectedValueOnce(new Error('pipelines boom'));
    renderTab();
    expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
    expect(screen.queryByText(/pipelines boom/)).toBeNull();
    // No report for a pipeline the picker could not name.
    expect(getPipelineReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listPipelines).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('12')).toBeTruthy();
  });

  it('switching pipelines in the picker re-fetches the report for the new id (CRMGAP-FE-9)', async () => {
    listPipelines.mockResolvedValueOnce([
      { pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] },
      { pipelineId: 'p2', name: 'Renewals', stages: [{ stageId: 's2', name: 'Due', probability: 50 }] },
    ]);
    renderTab();
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledTimes(1));
    expect(getPipelineReport).toHaveBeenNthCalledWith(1, 'o1', 'p1');

    const picker = await screen.findByLabelText('Pipeline');
    fireEvent.change(picker, { target: { value: 'p2' } });
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledTimes(2));
    expect(getPipelineReport).toHaveBeenNthCalledWith(2, 'o1', 'p2');
  });
});

describe('R2 CC-SP-3 — currency-grouped sums reach the table (review F2)', () => {
  it('renders one figure per currency in the sum cell — never the blind total', async () => {
    getPipelineReport.mockResolvedValueOnce({
      funnel: [],
      perStage: [
        { stageId: 's1', name: 'New', probability: 10, count: 3, sum: 1300, weightedSum: 130,
          sums: [
            { currency: null, sum: 1000, weightedSum: 100 },
            { currency: 'EUR', sum: 300, weightedSum: 30 },
          ] },
      ],
      totals: { openCount: 3, wonCount: 0, lostCount: 0, winRate: null },
      aging: [], snapshots: [], conversions: [],
      currencies: ['EUR'],
    });
    renderTab();
    // The grouped cell renders the EUR figure as real currency formatting…
    await waitFor(() => expect(screen.getByText((tx) => /€|EUR/.test(tx) && /300/.test(tx))).toBeTruthy());
    // …and the blind 1300 total does not appear anywhere.
    expect(screen.queryByText(/1[\s,.]?300/)).toBeNull();
  });

  it('>1 currency shows the snapshot mixed-currency caveat; 1 currency does not', async () => {
    const base: PipelineReport = {
      funnel: [],
      perStage: [
        { stageId: 's1', name: 'New', probability: 10, count: 2, sum: 800, weightedSum: 80,
          sums: [
            { currency: 'EUR', sum: 300, weightedSum: 30 },
            { currency: 'USD', sum: 500, weightedSum: 50 },
          ] },
      ],
      totals: { openCount: 2, wonCount: 0, lostCount: 0, winRate: null },
      aging: [],
      snapshots: [
        { isoWeek: '2026-W30', at: '2026-07-20T00:00:00Z', perStage: [{ stageId: 's1', name: 'New', probability: 10, count: 2, sum: 800, weightedSum: 80 }] },
        { isoWeek: '2026-W31', at: '2026-07-27T00:00:00Z', perStage: [{ stageId: 's1', name: 'New', probability: 10, count: 2, sum: 900, weightedSum: 90 }] },
      ],
      conversions: [],
    };
    getPipelineReport.mockResolvedValueOnce({ ...base, currencies: ['EUR', 'USD'] });
    const { unmount } = renderTab();
    await waitFor(() => expect(screen.getByText(/mixed currencies/i)).toBeTruthy());
    unmount();
    getPipelineReport.mockResolvedValueOnce({ ...base, currencies: ['USD'] });
    renderTab();
    // Wait for the SECOND report to actually render before asserting absence:
    // the old `waitFor(called)` passed on the first render's call and the
    // `queryByText` null passed on the second render's skeleton.
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledTimes(2));
    await screen.findByRole('table', { name: 'Weighted pipeline' });
    expect(screen.queryByText(/mixed currencies/i)).toBeNull();
  });
});

