/**
 * ADR 0417 P4 — MetricsPage component coverage: the catalog marks ONLY the
 * system metric with the "System" chip, and an inline run renders its points
 * (key, formatted value, n) in the result table. Clients mocked — pure
 * component test.
 *
 * The designed empty state is owned by `orgsFailedGuard.test.tsx` ("read
 * SUCCEEDS: the genuine …"), which also proves no failure card rides beside it.
 *
 * Sabotage-witnessed (w52, re-probed wave 115 after ADR 1052 changed the catalog
 * read to `{ metrics, viewer }`): inverting `m.system ?` moves the chip to the other
 * row, and a chip on every row (case 1 red); `r.points.length === 0` → `>= 0` hides
 * the points, the value left unformatted, the row count cell showing the value,
 * and the run sent for another org (case 2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';

vi.mock('../biClient.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../biClient.js')>();
  return {
    ...mod,
    listBiMetrics: vi.fn(),
    runBiMetric: vi.fn(),
    createBiMetric: vi.fn(),
    updateBiMetric: vi.fn(),
    deleteBiMetric: vi.fn(),
  };
});
vi.mock('../../../client/accessClient.js', () => ({ listOrgs: vi.fn() }));
vi.mock('../../entities/entitiesClient.js', () => ({ listEntityTypes: vi.fn() }));

import { listBiMetrics, runBiMetric, type MetricSummary } from '../biClient.js';
import { listOrgs, type Organization } from '../../../client/accessClient.js';
import { listEntityTypes } from '../../entities/entitiesClient.js';
import { MetricsPage } from '../MetricsPage.js';

const mockList = vi.mocked(listBiMetrics);
const mockRun = vi.mocked(runBiMetric);
const mockOrgs = vi.mocked(listOrgs);
const mockTypes = vi.mocked(listEntityTypes);

const metric = (metricId: string, over: Partial<MetricSummary> = {}): MetricSummary =>
  ({ metricId, title: metricId, entityType: 'crm.deal', aggregate: 'sum', field: 'amount', ...over });

beforeEach(() => {
  mockList.mockReset(); mockRun.mockReset(); mockOrgs.mockReset(); mockTypes.mockReset();
  const org: Organization = {
    orgId: 'o1', tenantId: 't1', name: 'Acme', slug: 'acme',
    createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  mockOrgs.mockResolvedValue([org]);
  mockTypes.mockResolvedValue([]);
});
afterEach(cleanup);

describe('MetricsPage (ADR 0417 P4)', () => {
  it('renders the catalog with the system chip', async () => {
    mockList.mockResolvedValue({ metrics: [metric('sys-pipeline-value', { title: 'Pipeline value', system: true }), metric('my-metric', { title: 'My metric' })], viewer: { canManage: true } });
    render(<MetricsPage />);
    // Settle on the system row (it renders under every sabotage probed here), then
    // assert by count, so a missing row or chip fails on the value, not a lookup throw.
    const sysRow = (await screen.findByText('Pipeline value')).closest('tr')!;
    expect(within(sysRow).queryAllByText('System')).toHaveLength(1);
    // Both catalog rows render.
    expect(screen.queryAllByText('My metric')).toHaveLength(1);
    // The tenant's own metric carries no chip — the chip is per ROW, not per page.
    const myRow = screen.getByText('My metric').closest('tr')!;
    expect(within(myRow).queryByText('System')).toBeNull();
  });

  it('runs a metric inline and renders the points', async () => {
    mockList.mockResolvedValue({ metrics: [metric('sys-pipeline-value', { title: 'Pipeline value', system: true })], viewer: { canManage: true } });
    mockRun.mockResolvedValue({
      metricId: 'sys-pipeline-value', title: 'Pipeline value', aggregate: 'sum', entityType: 'crm.deal',
      points: [{ key: '2026-07', value: 4000, n: 3 }], scope: 'org', totalRows: 3, bucket: 'month',
    });
    render(<MetricsPage />);
    fireEvent.click(await screen.findByText('Run'));
    // The run is mocked to resolve at once: settle it, then assert values, so a
    // result that never renders fails on the count, not on a `findBy` timing out.
    await act(async () => {});
    expect(mockRun.mock.calls).toEqual([['o1', 'sys-pipeline-value']]);
    const tables = screen.queryAllByRole('table', { name: 'Result for Pipeline value' });
    expect(tables).toHaveLength(1);
    const cells = within(tables[0]!).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['2026-07', '4,000', '3']);
  });
});
