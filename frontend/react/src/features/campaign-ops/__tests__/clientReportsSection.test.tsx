/**
 * ADR 0957 P0 — the internal review view for client reports.
 *
 *   - client reports off → renders nothing;
 *   - a failed read is said with a retry, never "no reports";
 *   - a report shows each figure with its source; a null figure reads "Not
 *     available" (never 0); the window note says the figures are not filtered
 *     to the period.
 *
 * Sabotage: rendering null as 0 reds the report case; mapping a failed read to
 * an empty list reds the failed case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import i18next from 'i18next';
import { render, cleanup, screen, fireEvent, act, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ listDefinitions: vi.fn(), listReports: vi.fn(), createDefinition: vi.fn(), computeReport: vi.fn(), sendReportForReview: vi.fn() }));
vi.mock('../reportsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

import { ClientReportsSection } from '../ClientReportsSection.js';
import { CampaignOpsError } from '../campaignOpsClient.js';
import type { ClientReport, ReportMetric } from '../reportsClient.js';

const DEF = { definitionId: 'rdef_1', orgId: 'o1', title: 'Monthly results', version: 1, campaignIds: 'all', sections: [], period: { kind: 'month', timezone: 'UTC' }, updatedAt: '2026-10-20T00:00:00Z' };
const lineage = { source: 'campaign-connectors.kpiSummary', computedAt: '2026-10-20T10:00:00.000Z', rows: 2, notes: ['all-data-to-computedAt', 'unreported-conversions:1'] };
const REPORT = {
  reportId: 'rpt_1', definitionId: 'rdef_1', definitionVersion: 1, title: 'Monthly results', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  snapshot: { metrics: { 'kpi.spend': { value: 200.5, unit: 'currency', currency: 'USD', previous: null, lineage }, 'kpi.cpa': { value: null, unit: 'currency', previous: null, lineage } }, tables: {} },
  snapshotHash: 'a'.repeat(64), status: 'draft', generatedAt: '2026-10-20T10:00:00.000Z',
};

// This is a stored-snapshot fixture, not a copy of the KPI reducer/adapter.
// Amount and count are deliberately independent: old numeric snapshots with
// count0 must not be reinterpreted by the UI after a new projection ships.
function availabilityReport(value: number | null, title: string, hashCharacter: string, count: number | undefined): ClientReport {
  const specs: Array<{ key: string; unit: ReportMetric['unit']; currency?: string }> = [
    { key: 'revenue', unit: 'currency', currency: 'USD' }, { key: 'roas', unit: 'ratio' },
    { key: 'conversions', unit: 'count' }, { key: 'cvr', unit: 'ratio' }, { key: 'cpa', unit: 'currency', currency: 'USD' },
  ];
  const metrics: Record<string, ReportMetric> = { 'kpi.spend': { value: 200.5, unit: 'currency', currency: 'USD', previous: null, lineage } };
  for (const spec of specs) metrics[`kpi.${spec.key}`] = { value, unit: spec.unit, ...(spec.currency ? { currency: spec.currency } : {}), previous: null, lineage };
  if (count !== undefined) {
    metrics['kpi.reportedRevenueRecordCount'] = { value: count, unit: 'count', previous: null, lineage };
    metrics['kpi.reportedConversionRecordCount'] = { value: count, unit: 'count', previous: null, lineage };
  }
  return { ...REPORT, reportId: `rpt_${hashCharacter}`, title, status: 'draft', snapshotHash: hashCharacter.repeat(64), snapshot: { metrics, tables: {} } };
}

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(cleanup);

describe('ClientReportsSection', () => {
  const label = (key: string) => String(i18next.t(`campaign-ops:${key}`));
  it('starts one review workflow for the current client and waits for its acknowledgement', async () => {
    h.listDefinitions.mockResolvedValue([DEF]); h.listReports.mockResolvedValue([]);
    let finish!: (value: { runId: string }) => void;
    h.sendReportForReview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ClientReportsSection orgId="o1" />);
    const button = await screen.findByRole('button', { name: label('reportsSendForReview') });
    fireEvent.click(button);
    expect(h.sendReportForReview).toHaveBeenCalledExactlyOnceWith('o1', 'rdef_1');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(label('reportsSentForReview'))).toBeNull();
    await act(async () => { finish({ runId: 'review-run' }); });
    expect(await screen.findByText(label('reportsSentForReview'))).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(h.computeReport).not.toHaveBeenCalled();
  });

  it('a refused start shows the failure without a success notice and permits retry', async () => {
    h.listDefinitions.mockResolvedValue([DEF]); h.listReports.mockResolvedValue([]);
    h.sendReportForReview.mockRejectedValueOnce(new CampaignOpsError('Review policy changed. Reload and try again.', 409)).mockResolvedValueOnce({ runId: 'retry-run' });
    render(<ClientReportsSection orgId="o1" />);
    const button = await screen.findByRole('button', { name: label('reportsSendForReview') });
    fireEvent.click(button);
    expect(await screen.findByText('Review policy changed. Reload and try again.')).toBeTruthy();
    expect(screen.queryByText(label('reportsSentForReview'))).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText(label('reportsSentForReview'))).toBeTruthy();
    expect(screen.queryByText('Review policy changed. Reload and try again.')).toBeNull();
    expect(h.sendReportForReview).toHaveBeenCalledTimes(2);
  });

  it('switching clients ignores a late review-start acknowledgement from the previous client', async () => {
    h.listDefinitions.mockImplementation((orgId: string) => Promise.resolve([{ ...DEF, orgId, title: orgId === 'o1' ? 'Client A report' : 'Client B report' }]));
    h.listReports.mockResolvedValue([]);
    let finish!: (value: { runId: string }) => void;
    h.sendReportForReview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<ClientReportsSection orgId="o1" />);
    fireEvent.click(await screen.findByRole('button', { name: label('reportsSendForReview') }));
    rerender(<ClientReportsSection orgId="o2" />);
    expect(await screen.findByText('Client B report')).toBeTruthy();
    const readsBeforeAcknowledgement = h.listDefinitions.mock.calls.map((args) => [...args]);
    await act(async () => { finish({ runId: 'old-client-run' }); });
    expect(h.listDefinitions.mock.calls).toEqual(readsBeforeAcknowledgement);
    expect(screen.queryByText(label('reportsSentForReview'))).toBeNull();
    expect(screen.getByText('Client B report')).toBeTruthy();
    expect(h.sendReportForReview).toHaveBeenCalledExactlyOnceWith('o1', 'rdef_1');
  });

  it('switching clients clears the draft and ignores the previous client’s late save refresh', async () => {
    let finishSave!: (value: unknown) => void;
    h.createDefinition.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    h.listDefinitions.mockImplementation((orgId: string) => Promise.resolve([{ ...DEF, orgId, title: orgId === 'o1' ? 'Client A report' : 'Client B report' }]));
    h.listReports.mockResolvedValue([]);
    const { rerender } = render(<ClientReportsSection orgId="o1" />);
    const input = await screen.findByRole('textbox', { name: 'New report title' });
    fireEvent.change(input, { target: { value: 'Private draft for A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create report' }));
    rerender(<ClientReportsSection orgId="o2" />);
    expect(await screen.findByText('Client B report')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'New report title' }) as HTMLInputElement).value).toBe('');
    await act(async () => { finishSave({}); });
    expect(screen.queryByText('Client A report')).toBeNull();
    expect(screen.getByText('Client B report')).toBeTruthy();
  });
  it('renders nothing when client reports are off', async () => {
    h.listDefinitions.mockRejectedValue(new CampaignOpsError('Client reports is not enabled for this tenant.', 404));
    h.listReports.mockResolvedValue([]);
    const { container } = render(<ClientReportsSection orgId="o1" />);
    await vi.waitFor(() => expect(h.listDefinitions).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
  });

  it('a failed read is said, with a retry', async () => {
    h.listDefinitions.mockRejectedValueOnce(new CampaignOpsError('boom', 500)).mockResolvedValueOnce([]);
    h.listReports.mockResolvedValue([]);
    render(<ClientReportsSection orgId="o1" />);
    expect(await screen.findByText('Reports could not be loaded. Nothing has changed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No reports yet/)).toBeTruthy();
  });

  it.each([0, 2])('labels source revenue-reporting count %s without confusing measured zero or leaking its internal key', async (count) => {
    h.listDefinitions.mockResolvedValue([DEF]);
    h.listReports.mockResolvedValue([{ ...REPORT, snapshot: { ...REPORT.snapshot, metrics: {
      ...REPORT.snapshot.metrics,
      'kpi.reportedRevenueRecordCount': { value: count, unit: 'count', previous: null, lineage },
    } } }]);
    render(<ClientReportsSection orgId="o1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Computed/ }));
    const table = await screen.findByRole('table', { name: 'Figures in Monthly results' });
    const header = within(table).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_reportedRevenueRecordCount')}` });
    const row = header.closest('tr');
    if (!row) throw new Error('reported count row missing');
    expect(within(row).getByRole('cell', { name: String(count) })).toBeTruthy();
    expect(row.textContent).not.toContain('reportedRevenueRecordCount');
    expect(row.textContent).not.toContain(label('reportsNotAvailable'));
    expect(table.textContent).toContain('$200.50');
  });

  it('shows each figure with its source; a missing figure is "Not available"', async () => {
    h.listDefinitions.mockResolvedValue([DEF]);
    h.listReports.mockResolvedValue([REPORT]);
    render(<ClientReportsSection orgId="o1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Computed/ }));
    const table = await screen.findByRole('table', { name: 'Figures in Monthly results' });
    expect(table.textContent).toContain('Ad performance: Spend');
    expect(table.textContent).toContain('$200.50');
    expect(table.textContent).toContain('Not available');
    expect(table.textContent).not.toMatch(/\$0\.00/);
    expect(table.textContent).toContain('not only this period');
    expect(table.textContent).toContain('Records without conversion data are left out: 1.');
  });

  it.each([0, 2])('labels source conversion-reporting count %s without confusing measured zero or leaking its internal key', async (count) => {
    h.listDefinitions.mockResolvedValue([DEF]);
    h.listReports.mockResolvedValue([{ ...REPORT, snapshot: { ...REPORT.snapshot, metrics: {
      ...REPORT.snapshot.metrics,
      'kpi.reportedConversionRecordCount': { value: count, unit: 'count', previous: null, lineage },
    } } }]);
    render(<ClientReportsSection orgId="o1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Computed/ }));
    const table = await screen.findByRole('table', { name: 'Figures in Monthly results' });
    const header = within(table).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_reportedConversionRecordCount')}` });
    const row = header.closest('tr');
    if (!row) throw new Error('conversion reporting count row missing');
    expect(within(row).getByRole('cell', { name: String(count) })).toBeTruthy();
    expect(row.textContent).not.toContain('reportedConversionRecordCount');
    expect(row.textContent).not.toContain(label('reportsNotAvailable'));
    expect(table.textContent).toContain('$200.50');
    expect(h.computeReport).not.toHaveBeenCalled();
    expect(h.sendReportForReview).not.toHaveBeenCalled();
  });

  it('a new stored unavailable snapshot renders each of the five null values in its own row', async () => {
    h.listDefinitions.mockResolvedValue([DEF]);
    h.listReports.mockResolvedValue([availabilityReport(null, 'Unavailable snapshot', 'b', 0)]);
    render(<ClientReportsSection orgId="o1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Computed/ }));
    const table = await screen.findByRole('table', { name: 'Figures in Unavailable snapshot' });
    for (const key of ['revenue', 'roas', 'conversions', 'cvr', 'cpa']) {
      const header = within(table).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label(`reportsMetric_${key}`)}` });
      const row = header.closest('tr');
      if (!row) throw new Error('availability metric row missing');
      expect(within(row).getByRole('cell', { name: label('reportsNotAvailable') })).toBeTruthy();
      expect(within(row).queryByRole('cell', { name: /^(?:0|\$0\.00)$/ })).toBeNull();
    }
    const spend = within(table).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_spend')}` }).closest('tr');
    if (!spend) throw new Error('spend row missing');
    expect(within(spend).getByRole('cell', { name: '$200.50' })).toBeTruthy();
    expect(h.computeReport).not.toHaveBeenCalled();
    expect(h.sendReportForReview).not.toHaveBeenCalled();
  });

  it('a measured-zero snapshot retains numeric zero in every amount and ratio row', async () => {
    h.listDefinitions.mockResolvedValue([DEF]);
    h.listReports.mockResolvedValue([availabilityReport(0, 'Measured zero snapshot', 'c', 1)]);
    render(<ClientReportsSection orgId="o1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Computed/ }));
    const table = await screen.findByRole('table', { name: 'Figures in Measured zero snapshot' });
    for (const [key, value] of [['revenue', '$0.00'], ['roas', '0'], ['conversions', '0'], ['cvr', '0'], ['cpa', '$0.00']] as const) {
      const header = within(table).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label(`reportsMetric_${key}`)}` });
      const row = header.closest('tr');
      if (!row) throw new Error('measured zero row missing');
      expect(within(row).getByRole('cell', { name: value })).toBeTruthy();
      expect(within(row).queryByText(label('reportsNotAvailable'))).toBeNull();
    }
    expect(h.computeReport).not.toHaveBeenCalled();
    expect(h.sendReportForReview).not.toHaveBeenCalled();
  });

  it('a legacy snapshot with no optional counts keeps its stored numeric zeros', async () => {
    h.listDefinitions.mockResolvedValue([DEF]);
    h.listReports.mockResolvedValue([availabilityReport(0, 'Legacy numeric snapshot', 'd', undefined)]);
    render(<ClientReportsSection orgId="o1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Computed/ }));
    const table = await screen.findByRole('table', { name: 'Figures in Legacy numeric snapshot' });
    for (const [key, value] of [['revenue', '$0.00'], ['roas', '0'], ['conversions', '0'], ['cvr', '0'], ['cpa', '$0.00']] as const) {
      const row = within(table).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label(`reportsMetric_${key}`)}` }).closest('tr');
      if (!row) throw new Error('legacy metric row missing');
      expect(within(row).getByRole('cell', { name: value })).toBeTruthy();
    }
    expect(within(table).queryByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_reportedRevenueRecordCount')}` })).toBeNull();
    expect(within(table).queryByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_reportedConversionRecordCount')}` })).toBeNull();
    expect(h.computeReport).not.toHaveBeenCalled();
    expect(h.sendReportForReview).not.toHaveBeenCalled();
  });

  it('old zero-with-count0 history and a new unavailable snapshot retain separate stored values and fingerprints', async () => {
    const old = availabilityReport(0, 'Historical zero snapshot', 'e', 0);
    const current = availabilityReport(null, 'New unavailable snapshot', 'f', 0);
    h.listDefinitions.mockResolvedValue([DEF]); h.listReports.mockResolvedValue([old, current]);
    render(<ClientReportsSection orgId="o1" />);
    const buttons = await screen.findAllByRole('button', { name: /^Computed/ });
    const oldButton = buttons[0]; const newButton = buttons[1];
    if (!oldButton || !newButton) throw new Error('both stored report controls are required');
    fireEvent.click(oldButton);
    const oldTable = await screen.findByRole('table', { name: 'Figures in Historical zero snapshot' });
    const oldRevenue = within(oldTable).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_revenue')}` }).closest('tr');
    if (!oldRevenue) throw new Error('historic revenue row missing');
    expect(within(oldRevenue).getByRole('cell', { name: '$0.00' })).toBeTruthy();
    expect(screen.getByTitle(old.snapshotHash).textContent).toBe(old.snapshotHash.slice(0, 10));
    fireEvent.click(newButton);
    const newTable = await screen.findByRole('table', { name: 'Figures in New unavailable snapshot' });
    const newRevenue = within(newTable).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_revenue')}` }).closest('tr');
    if (!newRevenue) throw new Error('new revenue row missing');
    expect(within(newRevenue).getByRole('cell', { name: label('reportsNotAvailable') })).toBeTruthy();
    expect(screen.getByTitle(current.snapshotHash).textContent).toBe(current.snapshotHash.slice(0, 10));
    fireEvent.click(oldButton);
    const history = await screen.findByRole('table', { name: 'Figures in Historical zero snapshot' });
    const historyRevenue = within(history).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_revenue')}` }).closest('tr');
    if (!historyRevenue) throw new Error('historical reread row missing');
    expect(within(historyRevenue).getByRole('cell', { name: '$0.00' })).toBeTruthy();
    expect(h.listReports).toHaveBeenCalledExactlyOnceWith('o1');
    expect(h.computeReport).not.toHaveBeenCalled();
    expect(h.sendReportForReview).not.toHaveBeenCalled();
  });

});
