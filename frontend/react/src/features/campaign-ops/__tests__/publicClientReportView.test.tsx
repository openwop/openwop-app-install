/**
 * ADR 0957 D5 (P2) — the client's link-only report page renders the frozen
 * snapshot through the SAME figures table as the agency review view.
 *
 *   - title, client and period come from the server's projection;
 *   - a null figure reads "Not available", never 0;
 *   - a LEGACY snapshot frozen before the reporting counts existed (the
 *     2026-11-08 correction: "older reports without it continue to render")
 *     renders its figures and invents no count row, no "Not available" for a
 *     count it never had, and leaks no internal metric key.
 *
 * Red witnesses (NOT RUN at authoring, 2026-11-19; the parent session runs them):
 *  - render `m.value ?? 0` in `MetricValue` (reportFigures.tsx) → the null case reds;
 *  - synthesize a row for every METRIC_NAMES entry → the legacy case reds;
 *  - render the snapshot keys raw instead of `metricLabel` → the key-leak assertion reds.
 */
import { describe, it, expect, afterEach } from 'vitest';
import i18next from 'i18next';
import { render, cleanup, screen, within } from '@testing-library/react';
import { PublicClientReportView } from '../PublicClientReportView.js';

afterEach(cleanup);

const lineage = { source: 'campaign-connectors.kpiSummary', computedAt: '2026-10-01T10:00:00.000Z', rows: 2, notes: ['all-data-to-computedAt'] };
/** Frozen before `reportedRevenueRecordCount` / `reportedConversionRecordCount`. */
const LEGACY = {
  kind: 'client_report', title: 'September results', clientName: 'Harbor Client', recipientName: 'Ann',
  periodStart: '2026-09-01', periodEnd: '2026-09-30', publishedAt: '2026-10-02T09:00:00.000Z', snapshotHash: 'b'.repeat(64),
  snapshot: {
    metrics: {
      'kpi.spend': { value: 200.5, unit: 'currency', currency: 'USD', previous: null, lineage },
      'kpi.cpa': { value: null, unit: 'currency', previous: null, lineage },
    },
    tables: {},
  },
};
const label = (key: string) => String(i18next.t(`campaign-ops:${key}`));

describe('PublicClientReportView', () => {
  it('shows the report\'s own title, client and period, and a null figure as "Not available"', () => {
    render(<PublicClientReportView resource={LEGACY} />);
    expect(screen.getByRole('heading', { level: 1, name: 'September results' })).toBeTruthy();
    expect(screen.getByText(/Harbor Client/)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Figures in September results' });
    expect(table.textContent).toContain('$200.50');
    const cpa = within(table).getByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label('reportsMetric_cpa')}` }).closest('tr');
    if (!cpa) throw new Error('cpa row missing');
    expect(cpa.textContent).toContain(label('reportsNotAvailable'));
    expect(table.textContent).not.toMatch(/\$0\.00/);
  });

  it('a legacy snapshot without reporting counts renders without inventing count rows', () => {
    render(<PublicClientReportView resource={LEGACY} />);
    const table = screen.getByRole('table', { name: 'Figures in September results' });
    for (const name of ['reportedRevenueRecordCount', 'reportedConversionRecordCount']) {
      expect(within(table).queryByRole('rowheader', { name: `${label('reportsSource_kpi')}: ${label(`reportsMetric_${name}`)}` })).toBeNull();
      expect(table.textContent).not.toContain(name);
    }
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + the two frozen figures
    expect(table.textContent).not.toContain('kpi.spend');
  });

  it('a projection with no figures says so rather than rendering an empty table', () => {
    render(<PublicClientReportView resource={{ ...LEGACY, snapshot: { metrics: {}, tables: {} } }} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(label('reportsPublicEmpty'))).toBeTruthy();
  });
});
