/**
 * ADR 0417 P4 — MetricsPage component coverage: renders the catalog (system
 * chip), the empty state, and the inline run result. Clients mocked — pure
 * component test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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
import { listOrgs } from '../../../client/accessClient.js';
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
  mockOrgs.mockResolvedValue([{ orgId: 'o1', tenantId: 't1', name: 'Acme', slug: 'acme' } as never]);
  mockTypes.mockResolvedValue([]);
});
afterEach(cleanup);

describe('MetricsPage (ADR 0417 P4)', () => {
  it('renders the catalog with the system chip', async () => {
    mockList.mockResolvedValue([metric('sys-pipeline-value', { title: 'Pipeline value', system: true }), metric('my-metric', { title: 'My metric' })]);
    render(<MetricsPage />);
    expect(await screen.findByText('Pipeline value')).toBeTruthy();
    expect(screen.getByText('System')).toBeTruthy();
    expect(screen.getByText('My metric')).toBeTruthy();
  });

  it('shows the designed empty state', async () => {
    mockList.mockResolvedValue([]);
    render(<MetricsPage />);
    expect(await screen.findByText('No metrics yet')).toBeTruthy();
  });

  it('runs a metric inline and renders the points', async () => {
    mockList.mockResolvedValue([metric('sys-pipeline-value', { title: 'Pipeline value', system: true })]);
    mockRun.mockResolvedValue({
      metricId: 'sys-pipeline-value', title: 'Pipeline value', aggregate: 'sum', entityType: 'crm.deal',
      points: [{ key: '2026-07', value: 4000, n: 2 }], totalRows: 2, bucket: 'month',
    });
    render(<MetricsPage />);
    fireEvent.click(await screen.findByText('Run'));
    expect(await screen.findByText('2026-07')).toBeTruthy();
    expect(mockRun).toHaveBeenCalledWith('o1', 'sys-pipeline-value');
  });
});
