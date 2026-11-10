/**
 * ADR 1052 D14 — the BI tile shows the open pipeline closing in the viewer's CURRENT
 * month, read by key over a bounded 12-month window that starts this month, plus the
 * total for those 12 months.
 *
 * RED on `46301fb8f`: the tile asked for an unbounded series and showed its LAST
 * point, so an `undated` bucket (which sorts after every `YYYY-MM`) or the
 * furthest-future close month became "latest", and the delta compared whichever two
 * points happened to be last. The UX grade then found the first fix looked BACKWARDS
 * (past close months of open deals are overdue deals, not pipeline); the request
 * window is asserted here so that cannot come back unseen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../bi/biClient.js', () => ({ runBiMetric: vi.fn() }));
vi.mock('../useOrgResource.js', () => ({ useOrgResource: vi.fn() }));
vi.mock('../sharedRead.js', () => ({ sharedRead: (_k: string, fn: () => unknown) => fn() }));

import { runBiMetric, type MetricRunResult } from '../../bi/biClient.js';
import { useOrgResource } from '../useOrgResource.js';
import BiMetricTile, { pipelineWindow } from '../tiles/BiMetricTile.js';

const mockResource = vi.mocked(useOrgResource);
const mockRun = vi.mocked(runBiMetric);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 15, 12, 0, 0)); // local 2026-11-15
  mockResource.mockReset(); mockRun.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('BiMetricTile (ADR 1052 D14)', () => {
  it('the window is the 12 months starting with the current local month', () => {
    const w = pipelineWindow(new Date(2026, 10, 15, 12, 0, 0));
    expect(w).toMatchObject({ since: '2026-11-01', until: '2027-10-31' });
    expect(w.months[0]).toBe('2026-11');
    expect(w.months.at(-1)).toBe('2027-10');
  });

  it('asks for that window and shows this month by key plus the 12-month total', async () => {
    const data: MetricRunResult = {
      metricId: 'sys-pipeline-value', title: 'Pipeline value', aggregate: 'sum', entityType: 'crm.deal', totalRows: 4, scope: 'org',
      // Out of order, with a past (overdue) month outside the window: only the KEY decides.
      points: [{ key: '2027-03', value: 9999, n: 1 }, { key: '2026-11', value: 500, n: 1 }, { key: '2026-10', value: 200, n: 2 }],
    };
    mockResource.mockImplementation((fetcher) => {
      void fetcher('o1');
      return { status: 'ready', data };
    });
    render(<BiMetricTile compact={false} />);
    expect(mockRun).toHaveBeenCalledWith('o1', 'sys-pipeline-value', { bucket: 'month', since: '2026-11-01', until: '2027-10-31' });
    expect(await screen.findByText('500')).toBeTruthy();
    expect(screen.getByText('10,499')).toBeTruthy(); // 500 + 9,999; the overdue 200 is not pipeline
  });
});
