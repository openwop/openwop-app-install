/**
 * ADR 0417 P4 — MetricsPage component coverage: the catalog marks ONLY the
 * system metric with the "System" chip, and an inline run renders its points
 * (key, formatted value, n) in the result table. Clients mocked — pure
 * component test.
 *
 * The designed empty state is owned by `orgsFailedGuard.test.tsx` ("read
 * SUCCEEDS: the genuine …"), which also proves no failure card rides beside it.
 *
 * Sabotage-witnessed (w52): inverting `m.system ?` moves the chip to the other
 * row (case 1 red); `r.points.length === 0` → `>= 0` hides the points (case 2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

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
    mockList.mockResolvedValue([metric('sys-pipeline-value', { title: 'Pipeline value', system: true }), metric('my-metric', { title: 'My metric' })]);
    render(<MetricsPage />);
    const sysRow = (await screen.findByText('Pipeline value')).closest('tr')!;
    expect(within(sysRow).getByText('System')).toBeTruthy();
    // The tenant's own metric carries no chip — the chip is per ROW, not per page.
    const myRow = screen.getByText('My metric').closest('tr')!;
    expect(within(myRow).queryByText('System')).toBeNull();
  });

  it('runs a metric inline and renders the points', async () => {
    mockList.mockResolvedValue([metric('sys-pipeline-value', { title: 'Pipeline value', system: true })]);
    mockRun.mockResolvedValue({
      metricId: 'sys-pipeline-value', title: 'Pipeline value', aggregate: 'sum', entityType: 'crm.deal',
      points: [{ key: '2026-07', value: 4000, n: 3 }], totalRows: 3, bucket: 'month',
    });
    render(<MetricsPage />);
    fireEvent.click(await screen.findByText('Run'));
    const table = await screen.findByRole('table', { name: 'Result for Pipeline value' });
    const cells = within(table).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['2026-07', '4,000', '3']);
    expect(mockRun).toHaveBeenCalledWith('o1', 'sys-pipeline-value');
  });
});
