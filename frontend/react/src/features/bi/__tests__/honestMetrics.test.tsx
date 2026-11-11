/**
 * ADR 1052 — the metrics page offers only what the caller may do (D11), keeps a
 * metric's filters and version through an edit (D8/D12), names the field that made a
 * metric stale (D1), and says when a run is partial or workspace-wide (D2–D4).
 *
 * Every case was RED on `46301fb8f`: readers were offered New/Edit/Delete; saving an
 * edit sent no `filters` (PATCH replaces, so they were deleted) and no version; a
 * stale metric looked runnable; `groupsTruncated` and `undatedRows` were never shown;
 * a lost edit race had no message of its own. Also red when a save goes to another
 * org or metric id, or a late org-A reply paints org B (re-grade L1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';

vi.mock('../biClient.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../biClient.js')>();
  return { ...mod, listBiMetrics: vi.fn(), runBiMetric: vi.fn(), createBiMetric: vi.fn(), updateBiMetric: vi.fn(), deleteBiMetric: vi.fn(), adoptBiMetric: vi.fn() };
});
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../client/accessClient.js', () => ({ listOrgs: vi.fn() }));
vi.mock('../../entities/entitiesClient.js', () => ({ listEntityTypes: vi.fn() }));

import { listBiMetrics, runBiMetric, updateBiMetric, adoptBiMetric, type MetricSummary, type MetricCatalog, type BiRequestError } from '../biClient.js';
import { listOrgs, type Organization } from '../../../client/accessClient.js';
import { listEntityTypes } from '../../entities/entitiesClient.js';
import { MetricsPage } from '../MetricsPage.js';

const mockList = vi.mocked(listBiMetrics);
const mockRun = vi.mocked(runBiMetric);
const mockUpdate = vi.mocked(updateBiMetric);

const filtered: MetricSummary = {
  metricId: 'open-hours', title: 'Open hours', entityType: 'job', aggregate: 'sum', field: 'hours',
  filters: [{ key: 'state', op: 'neq', value: 'closed' }], updatedAt: '2026-11-01T00:00:00.000Z',
};

beforeEach(() => {
  for (const m of [mockList, mockRun, mockUpdate, vi.mocked(adoptBiMetric), vi.mocked(listOrgs), vi.mocked(listEntityTypes)]) m.mockReset();
  const org: Organization = { orgId: 'o1', tenantId: 't1', name: 'Acme', slug: 'acme', createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  vi.mocked(listOrgs).mockResolvedValue([org]);
  vi.mocked(listEntityTypes).mockResolvedValue([]);
});
afterEach(cleanup);

describe('ADR 1052 — honest metrics page', () => {
  it('D11: a reader is offered Run but no New, Edit or Delete', async () => {
    mockList.mockResolvedValue({ metrics: [filtered], viewer: { canManage: false } });
    render(<MetricsPage />);
    const row = (await screen.findByText('Open hours')).closest('tr')!;
    expect(within(row).getByText('Run')).toBeTruthy();
    expect(within(row).queryByText('Edit')).toBeNull();
    expect(within(row).queryByText('Delete')).toBeNull();
    expect(screen.queryByText('New metric')).toBeNull();
  });

  it('D12/D8: an edit keeps the filters it did not touch and sends the version it was made against', async () => {
    mockList.mockResolvedValue({ metrics: [filtered], viewer: { canManage: true } });
    mockUpdate.mockResolvedValue(filtered);
    render(<MetricsPage />);
    const row = (await screen.findByText('Open hours')).closest('tr')!;
    fireEvent.click(within(row).getByText('Edit'));
    // The stored filter is shown in the editor, not silently carried or dropped.
    expect(await screen.findByText('closed')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Open hours (renamed)' } });
    fireEvent.click(screen.getByText('Save metric'));
    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    // Saved into THIS org's metric, with the filters and the version it was made against.
    expect(mockUpdate).toHaveBeenCalledWith('o1', 'open-hours', expect.objectContaining({
      title: 'Open hours (renamed)',
      filters: [{ key: 'state', op: 'neq', value: 'closed' }],
      expectedUpdatedAt: '2026-11-01T00:00:00.000Z',
    }));
  });

  it('D12: removing the only filter sends an empty list (PATCH replaces), never an omitted key', async () => {
    mockList.mockResolvedValue({ metrics: [filtered], viewer: { canManage: true } });
    mockUpdate.mockResolvedValue(filtered);
    render(<MetricsPage />);
    fireEvent.click(within((await screen.findByText('Open hours')).closest('tr')!).getByText('Edit'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove filter 1 (state)' }));
    fireEvent.click(screen.getByText('Save metric'));
    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate).toHaveBeenCalledWith('o1', 'open-hours', expect.objectContaining({ filters: [] }));
  });

  it('D8: a lost edit race says so and offers a reload, instead of a raw error', async () => {
    mockList.mockResolvedValue({ metrics: [filtered], viewer: { canManage: true } });
    const err: BiRequestError = Object.assign(new Error('This metric was changed by someone else.'), { reason: 'metric_changed', status: 409 });
    mockUpdate.mockRejectedValue(err);
    render(<MetricsPage />);
    fireEvent.click(within((await screen.findByText('Open hours')).closest('tr')!).getByText('Edit'));
    fireEvent.click(await screen.findByText('Save metric'));
    expect(await screen.findByText('Reload metrics')).toBeTruthy();
    // The page's own conflict copy, never the server's raw message.
    expect(screen.getByText(/Someone else saved this metric after you opened it, so your changes were not saved\./)).toBeTruthy();
    expect(screen.queryByText('This metric was changed by someone else.')).toBeNull();
  });

  it('UX H2: a filter typed but not added blocks Save with the reason on the filter', async () => {
    mockList.mockResolvedValue({ metrics: [filtered], viewer: { canManage: true } });
    render(<MetricsPage />);
    fireEvent.click(within((await screen.findByText('Open hours')).closest('tr')!).getByText('Edit'));
    fireEvent.change(await screen.findByLabelText('Filter field'), { target: { value: 'hours' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Save metric'));
    expect(await screen.findByText('Add or clear this filter before saving.')).toBeTruthy();
    expect(mockUpdate).not.toHaveBeenCalled();
    // The error is on the control that has focus (UX re-grade M2), and Clear exists.
    expect(document.activeElement).toBe(screen.getByLabelText('Value'));
    fireEvent.click(screen.getByText('Clear'));
    expect(screen.getByLabelText('Filter field')).toHaveProperty('value', '');
  });

  it('UX M4/M7: after a conflict Save is disabled; a refused filter is named on its own row', async () => {
    mockList.mockResolvedValue({ metrics: [filtered], viewer: { canManage: true } });
    const refused: BiRequestError = Object.assign(new Error('filters[0]: values on `state` must be strings.'), { field: 'filters', index: 0, status: 422 });
    mockUpdate.mockRejectedValueOnce(refused);
    render(<MetricsPage />);
    fireEvent.click(within((await screen.findByText('Open hours')).closest('tr')!).getByText('Edit'));
    fireEvent.click(await screen.findByText('Save metric'));
    const row = (await screen.findByText('filters[0]: values on `state` must be strings.')).closest('li')!;
    expect(within(row).getByText('state')).toBeTruthy();

    mockUpdate.mockRejectedValueOnce(Object.assign(new Error('changed'), { reason: 'metric_changed', status: 409 }));
    fireEvent.click(screen.getByText('Save metric'));
    await screen.findByText('Reload metrics');
    expect(screen.getByRole('button', { name: 'Save metric' })).toHaveProperty('disabled', true);
  });

  it('UX M8/M10: a reader sees why a metric cannot run, in text, and an empty state that does not ask them to define one', async () => {
    mockList.mockResolvedValue({ metrics: [{ ...filtered, stale: { field: 'hours' } }], viewer: { canManage: false } });
    const { unmount } = render(<MetricsPage />);
    const row = (await screen.findByText('Open hours')).closest('tr')!;
    expect(within(row).getByText("Can't run: hours")).toBeTruthy();
    expect(within(row).getByText(/An admin needs to edit it before it can run\./)).toBeTruthy();
    unmount();
    mockList.mockResolvedValue({ metrics: [], viewer: { canManage: false } });
    render(<MetricsPage />);
    expect(await screen.findByText('No metrics are defined for this organization yet. An admin can define them.')).toBeTruthy();
  });

  it('grade-code M3: switching organization closes an open editor, so it cannot save into the other org', async () => {
    const orgB: Organization = { orgId: 'o2', tenantId: 't1', name: 'Beta', slug: 'beta', createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    vi.mocked(listOrgs).mockResolvedValue([{ ...orgB, orgId: 'o1', name: 'Acme', slug: 'acme' }, orgB]);
    mockList.mockResolvedValue({ metrics: [filtered], viewer: { canManage: true } });
    render(<MetricsPage />);
    fireEvent.click(within((await screen.findByText('Open hours')).closest('tr')!).getByText('Edit'));
    expect(await screen.findByText('Edit metric')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /organization/i }), { target: { value: 'o2' } });
    // Wait for org B's catalog to LAND (canManage true again), then the editor must
    // still be closed: hiding it only while loading is not enough.
    await vi.waitFor(() => expect(mockList).toHaveBeenLastCalledWith('o2'));
    await screen.findByText('Open hours');
    await vi.waitFor(() => expect(screen.getByText('Open hours').closest('tr')!.textContent).toContain('Edit'));
    expect(screen.queryByText('Edit metric')).toBeNull();
  });

  it('UX re-grade M1: a metric that turns out stale on Run is announced and focus moves to its reason', async () => {
    mockList.mockResolvedValue({ metrics: [filtered], viewer: { canManage: true } });
    mockRun.mockRejectedValue(Object.assign(new Error('stale'), { reason: 'metric_stale', field: 'hours', status: 422 }));
    render(<MetricsPage />);
    fireEvent.click(await screen.findByText('Run'));
    const reason = await screen.findByText(/“hours” changed or was removed/, { selector: 'span' });
    expect(screen.getByRole('status').textContent).toContain('“hours” changed or was removed');
    await vi.waitFor(() => expect(document.activeElement).toBe(reason));
  });

  it('re-grade L1: a late reply for the org the user left is dropped', async () => {
    const orgB: Organization = { orgId: 'o2', tenantId: 't1', name: 'Beta', slug: 'beta', createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    vi.mocked(listOrgs).mockResolvedValue([{ ...orgB, orgId: 'o1', name: 'Acme', slug: 'acme' }, orgB]);
    let releaseA: (c: MetricCatalog) => void = () => undefined;
    mockList.mockImplementation((org) => (org === 'o1'
      ? new Promise<MetricCatalog>((r) => { releaseA = r; })
      : Promise.resolve({ metrics: [{ ...filtered, metricId: 'b-metric', title: 'B metric' }], viewer: { canManage: false } })));
    render(<MetricsPage />);
    await vi.waitFor(() => expect(mockList).toHaveBeenCalledWith('o1'));
    fireEvent.change(await screen.findByRole('combobox', { name: /organization/i }), { target: { value: 'o2' } });
    expect(await screen.findByText('B metric')).toBeTruthy();
    // Org A's reply lands late, carrying a manager permission: it must change nothing.
    // `act` flushes the reply's `.then` before the assertions (no wall-clock wait).
    await act(async () => { releaseA({ metrics: [filtered], viewer: { canManage: true } }); });
    expect(screen.getByText('B metric')).toBeTruthy();
    expect(screen.queryByText('Open hours')).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
  });

  it('BI84WF-12: a pre-1052 shared metric is marked, read-only, and a manager can move it here', async () => {
    mockList.mockResolvedValue({ metrics: [{ ...filtered, legacy: true }], viewer: { canManage: true } });
    vi.mocked(adoptBiMetric).mockResolvedValue(filtered);
    render(<MetricsPage />);
    const row = (await screen.findByText('Open hours')).closest('tr')!;
    expect(within(row).getByText('Shared')).toBeTruthy();
    expect(within(row).queryByText('Edit')).toBeNull();
    expect(within(row).queryByText('Delete')).toBeNull();
    fireEvent.click(within(row).getByText('Move here'));
    await vi.waitFor(() => expect(adoptBiMetric).toHaveBeenCalledWith('o1', 'open-hours'));
  });

  it('D1: a stale metric names its field and offers no Run', async () => {
    mockList.mockResolvedValue({ metrics: [{ ...filtered, stale: { field: 'hours' } }], viewer: { canManage: true } });
    render(<MetricsPage />);
    const row = (await screen.findByText('Open hours')).closest('tr')!;
    expect(within(row).getByText('Needs edit: hours')).toBeTruthy();
    expect(within(row).queryByText('Run')).toBeNull();
  });

  it('D2–D4: a run says it is workspace-wide, which groups it dropped, and how many rows it could not date', async () => {
    mockList.mockResolvedValue({ metrics: [{ ...filtered, filters: [] }], viewer: { canManage: false } });
    mockRun.mockResolvedValue({
      metricId: 'open-hours', title: 'Open hours', aggregate: 'sum', entityType: 'job',
      points: [{ key: 'open', value: 8, n: 2 }], scope: 'tenant', totalRows: 5, groupedBy: 'state',
      groupsTruncated: true, droppedGroups: 3, undatedRows: 1,
    });
    render(<MetricsPage />);
    fireEvent.click(await screen.findByText('Run'));
    expect(await screen.findByText('Custom entity types are counted across the whole workspace, not only this organization.')).toBeTruthy();
    expect(screen.getByText('Only the largest groups are shown — 3 more groups were left out.')).toBeTruthy();
    expect(screen.getByText('1 row has no usable date, so it is not in this series.')).toBeTruthy();
  });
});
