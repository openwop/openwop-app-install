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
import { render, screen, cleanup, waitFor, fireEvent, within, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { PipelineReport } from '../crmReportsClient.js';
import type * as OrgClient from '../crmOrgClient.js';
import type * as ReportsClient from '../crmReportsClient.js';

const listPipelines = vi.hoisted(() => vi.fn<typeof OrgClient.listPipelines>(async () => [
  { pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] },
]));
vi.mock('../crmOrgClient.js', () => ({
  listPipelines,
}));

const getPipelineReport = vi.hoisted(() => vi.fn<typeof ReportsClient.getPipelineReport>(async (): Promise<PipelineReport> => ({
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


/** CRM-REPORT-ORG-PIPELINE-1: actual interleaved requests, not state-shape pins. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized deferred'); };
  let reject: (error: Error) => void = () => { throw new Error('uninitialized deferred'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const pipelineRows = (id: string): Awaited<ReturnType<typeof OrgClient.listPipelines>> => [
  { pipelineId: id, name: id, stages: [{ stageId: 's1', name: 'New', probability: 10 }] },
];
const reportWithCount = (count: number): PipelineReport => ({
  funnel: [], perStage: [], totals: { openCount: count, wonCount: 0, lostCount: 0, winRate: null },
  aging: [], snapshots: [], conversions: [],
});
const reportTree = (org: string) => <MemoryRouter><ReportsTab orgId={org} /></MemoryRouter>;

describe('CRM-REPORT-ORG-PIPELINE-1 request ownership', () => {
  it('waits for the new org catalog without issuing a new-org/old-pipeline report', async () => {
    const catalogB = deferred<Awaited<ReturnType<typeof OrgClient.listPipelines>>>();
    listPipelines.mockImplementation(async (org) => org === 'A' ? pipelineRows('pa') : catalogB.promise);
    getPipelineReport.mockResolvedValue(reportWithCount(101));
    const view = render(reportTree('A'));
    await screen.findByText('101');
    view.rerender(reportTree('B'));
    expect(screen.queryByText('101')).toBeNull();
    expect(getPipelineReport.mock.calls).toEqual([['A', 'pa']]);
    getPipelineReport.mockResolvedValue(reportWithCount(202));
    await act(async () => { catalogB.resolve(pipelineRows('pb')); });
    await screen.findByText('202');
    expect(getPipelineReport.mock.calls).toEqual([['A', 'pa'], ['B', 'pb']]);
  });

  it.each(['success', 'failure'] as const)('ignores old-org report %s after current metrics render', async (settle) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const old = deferred<PipelineReport>();
    listPipelines.mockImplementation(async (org) => pipelineRows(org));
    getPipelineReport.mockImplementation(async (org) => org === 'A' ? old.promise : reportWithCount(202));
    const view = render(reportTree('A'));
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledWith('A', 'A'));
    view.rerender(reportTree('B'));
    await screen.findByText('202');
    await act(async () => {
      if (settle === 'success') old.resolve(reportWithCount(101));
      else old.reject(new Error('old org rejected'));
    });
    expect(screen.getByText('202')).toBeTruthy();
    expect(screen.queryByText('101')).toBeNull();
    expect(screen.queryByText('Could not load this')).toBeNull();
  });

  it.each(['success', 'failure'] as const)('ignores earlier A catalog %s after A to B to A', async (settle) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstA = deferred<Awaited<ReturnType<typeof OrgClient.listPipelines>>>();
    let aReads = 0;
    listPipelines.mockImplementation(async (org) => org === 'A' && ++aReads === 1 ? firstA.promise : pipelineRows(org));
    getPipelineReport.mockResolvedValue(reportWithCount(303));
    const view = render(reportTree('A'));
    await waitFor(() => expect(listPipelines).toHaveBeenCalledWith('A'));
    view.rerender(reportTree('B'));
    await screen.findByText('303');
    view.rerender(reportTree('A'));
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledWith('A', 'A'));
    await act(async () => {
      if (settle === 'success') firstA.resolve(pipelineRows('obsolete'));
      else firstA.reject(new Error('obsolete catalog failed'));
    });
    expect(getPipelineReport).not.toHaveBeenCalledWith('A', 'obsolete');
    expect(screen.getByText('303')).toBeTruthy();
    expect(screen.queryByText('Could not load this')).toBeNull();
  });

  it.each(['success', 'failure'] as const)('keeps latest pipeline metrics after prior pipeline %s', async (settle) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const old = deferred<PipelineReport>();
    listPipelines.mockResolvedValue([...pipelineRows('p1'), ...pipelineRows('p2')]);
    getPipelineReport.mockImplementation(async (_org, pipeline) => pipeline === 'p1' ? old.promise : reportWithCount(202));
    renderTab();
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledWith('o1', 'p1'));
    fireEvent.change(screen.getByLabelText('Pipeline'), { target: { value: 'p2' } });
    await screen.findByText('202');
    await act(async () => {
      if (settle === 'success') old.resolve(reportWithCount(101));
      else old.reject(new Error('old pipeline rejected'));
    });
    expect(screen.getByText('202')).toBeTruthy();
    expect(screen.queryByText('101')).toBeNull();
    expect(screen.queryByText('Could not load this')).toBeNull();
  });

  it('Retry retains the selected pipeline and current failures recover through both reads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retryCatalog = deferred<Awaited<ReturnType<typeof OrgClient.listPipelines>>>();
    const rows = [...pipelineRows('p1'), ...pipelineRows('p2')];
    listPipelines.mockResolvedValueOnce(rows).mockReturnValueOnce(retryCatalog.promise);
    getPipelineReport.mockImplementation(async (_org, pipeline) => {
      if (pipeline === 'p2') throw new Error('current report failed');
      return reportWithCount(101);
    });
    renderTab();
    await screen.findByText('101');
    fireEvent.change(screen.getByLabelText('Pipeline'), { target: { value: 'p2' } });
    await screen.findByText('Could not load this');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText('101')).toBeNull();
    expect(screen.queryByText('Could not load this')).toBeNull();
    expect(getPipelineReport).toHaveBeenCalledTimes(2);
    getPipelineReport.mockResolvedValue(reportWithCount(202));
    await act(async () => { retryCatalog.resolve(rows); });
    await screen.findByText('202');
    expect(listPipelines).toHaveBeenCalledTimes(2);
    expect(getPipelineReport).toHaveBeenLastCalledWith('o1', 'p2');
    expect(getPipelineReport).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Could not load this')).toBeNull();
  });

  it('a pre-Retry report cannot overwrite the recovered selected pipeline', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const old = deferred<PipelineReport>();
    listPipelines.mockResolvedValue([...pipelineRows('p1'), ...pipelineRows('p2')]);
    getPipelineReport.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('current failed'));
    renderTab();
    await waitFor(() => expect(getPipelineReport).toHaveBeenCalledWith('o1', 'p1'));
    fireEvent.change(screen.getByLabelText('Pipeline'), { target: { value: 'p2' } });
    await screen.findByText('Could not load this');
    getPipelineReport.mockResolvedValue(reportWithCount(202));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('202');
    await act(async () => { old.resolve(reportWithCount(101)); });
    expect(screen.getByText('202')).toBeTruthy();
    expect(screen.queryByText('101')).toBeNull();
    expect(screen.queryByText('Could not load this')).toBeNull();
    expect(getPipelineReport).toHaveBeenLastCalledWith('o1', 'p2');
    expect(listPipelines).toHaveBeenCalledTimes(2);
  });

  it('StrictMode cleanup ignores its first catalog but the current setup stays live', async () => {
    const first = deferred<Awaited<ReturnType<typeof OrgClient.listPipelines>>>();
    listPipelines.mockReturnValueOnce(first.promise).mockResolvedValue(pipelineRows('current'));
    getPipelineReport.mockResolvedValue(reportWithCount(404));
    render(<StrictMode>{reportTree('A')}</StrictMode>);
    await screen.findByText('404');
    await act(async () => { first.resolve(pipelineRows('obsolete')); });
    expect(getPipelineReport.mock.calls).toEqual([['A', 'current']]);
    expect(screen.getByText('404')).toBeTruthy();
  });
});
