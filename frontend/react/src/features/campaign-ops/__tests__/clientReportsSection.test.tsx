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
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ listDefinitions: vi.fn(), listReports: vi.fn(), createDefinition: vi.fn(), computeReport: vi.fn(), sendReportForReview: vi.fn() }));
vi.mock('../reportsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

import { ClientReportsSection } from '../ClientReportsSection.js';
import { CampaignOpsError } from '../campaignOpsClient.js';

const DEF = { definitionId: 'rdef_1', orgId: 'o1', title: 'Monthly results', version: 1, campaignIds: 'all', sections: [], period: { kind: 'month', timezone: 'UTC' }, updatedAt: '2026-10-20T00:00:00Z' };
const lineage = { source: 'campaign-connectors.kpiSummary', computedAt: '2026-10-20T10:00:00.000Z', rows: 2, notes: ['all-data-to-computedAt', 'unreported-conversions:1'] };
const REPORT = {
  reportId: 'rpt_1', definitionId: 'rdef_1', definitionVersion: 1, title: 'Monthly results', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  snapshot: { metrics: { 'kpi.spend': { value: 200.5, unit: 'currency', currency: 'USD', previous: null, lineage }, 'kpi.cpa': { value: null, unit: 'currency', previous: null, lineage } }, tables: {} },
  snapshotHash: 'a'.repeat(64), status: 'draft', generatedAt: '2026-10-20T10:00:00.000Z',
};

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
});
