/**
 * <DataTable> — the one tabular-data primitive. What this file guards, and what
 * breaks if it fails:
 *   - key/value semantics: an opt-in `rowHeader` column renders `th scope=row`
 *     and the caption names the table (screen readers announce "host, row header");
 *   - JSUX-LIST-1 (filter half): a case-insensitive filter over EVERY column's
 *     sortValue projection (or a caller `textOf`); a filter with no hits is a
 *     DISTINCT "no rows match" state, never the `empty` slot that claims "no data
 *     yet" (the failure-as-empty family); results are announced once, debounced,
 *     through the shell live region (WCAG 4.1.3);
 *   - stacked headers glue a spaced connector to the word before it, so it cannot
 *     orphan onto its own line, and leave headers verbatim when off;
 *   - CSM R3: a null sortValue sinks LAST in both directions.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { DataTable, type DataColumn } from '../DataTable.js';
import { announce } from '../announce.js';

vi.mock('../announce.js', () => ({ announce: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

interface Row { id: string; name: string }
const rows: Row[] = [{ id: 'a', name: 'Alpha' }];
const rowKey = (r: Row): string => r.id;

const cols: DataColumn<Row>[] = [
  { key: 'name', header: 'Compliance / legislative risk', render: (r) => r.name },
  { key: 'intake', header: 'Intake & evidence', render: () => 'x' },
  { key: 'plain', header: 'Return on investment', render: () => 'y' },
];

const NBSP = '\u00A0';
const headerTexts = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll('thead th')).map((th) => th.textContent ?? '');

describe('semantic key/value tables', () => {
  it('renders an opt-in row-header column and an accessible caption', () => {
    render(<DataTable caption="Identity" rows={[{ key: 'host', value: 'openwop' }]} rowKey={(r) => r.key} columns={[
      { key: 'key', header: 'Field', rowHeader: true, render: (r) => r.key },
      { key: 'value', header: 'Value', render: (r) => r.value },
    ]} />);
    expect(screen.getByRole('rowheader', { name: 'host' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Identity' })).toBeTruthy();
  });
});

describe('filterable (JSUX-LIST-1 filter half)', () => {
  const rows = [
    { id: '1', name: 'Alpha Corp', stage: 'applied' },
    { id: '2', name: 'Beta LLC', stage: 'screening' },
    { id: '3', name: 'Gamma Inc', stage: 'applied' },
  ];
  const columns = [
    { key: 'name', header: 'Name', sortValue: (r: typeof rows[number]) => r.name, render: (r: typeof rows[number]) => r.name },
    { key: 'stage', header: 'Stage', sortValue: (r: typeof rows[number]) => r.stage, render: (r: typeof rows[number]) => r.stage },
  ];

  it('narrows rows case-insensitively over sortValue projections; clearing restores', () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} filterable={{ placeholder: 'Filter…' }} />);
    const input = screen.getByRole('searchbox', { name: 'Filter…' });
    // Upper-case query against mixed-case data: both sides are case-folded.
    fireEvent.change(input, { target: { value: 'BETA' } });
    expect(screen.queryByText('Alpha Corp')).toBeNull();
    expect(screen.getByText('Beta LLC')).toBeTruthy();
    // A value only the SECOND column's projection carries (stage) — every
    // column is searched, not just the first.
    fireEvent.change(input, { target: { value: 'screening' } });
    expect(screen.getByText('Beta LLC')).toBeTruthy();
    expect(screen.queryByText('Alpha Corp')).toBeNull();
    expect(screen.queryByText('Gamma Inc')).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('Alpha Corp')).toBeTruthy();
    expect(screen.getByText('Gamma Inc')).toBeTruthy();
  });

  it('zero matches renders the DISTINCT no-match state — never the empty slot', () => {
    render(
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id}
        filterable={{ placeholder: 'Filter…' }} empty={<p>no data yet</p>} />,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter…' }), { target: { value: 'zzz' } });
    expect(screen.getByText(/no rows match/i)).toBeTruthy();
    expect(screen.queryByText('no data yet')).toBeNull(); // never the empty-slot claim
  });

  it('an EMPTY rows array renders the empty slot and no filter input (nothing to filter)', () => {
    const noRows: typeof rows = [];
    render(
      <DataTable rows={noRows} columns={columns} rowKey={(r) => r.id}
        filterable={{ placeholder: 'Filter…' }} empty={<p>no data yet</p>} />,
    );
    expect(screen.getByText('no data yet')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('filter results are ANNOUNCED via the global live region (debounced) — both the count and the no-match case', () => {
    // The visible no-match <p> deliberately has NO role="status": a live
    // region born WITH its text announces unreliably (repo doctrine); the
    // announcement rides announce() → the always-mounted GlobalLiveRegion.
    vi.useFakeTimers();
    try {
      render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} filterable={{ placeholder: 'Filter…' }} />);
      const input = screen.getByRole('searchbox', { name: 'Filter…' });
      fireEvent.change(input, { target: { value: 'b' } });
      vi.advanceTimersByTime(200);
      expect(announce).not.toHaveBeenCalled(); // debounce: nothing mid-typing
      // A keystroke inside the window RESTARTS it: the 'b' announcement is dropped.
      fireEvent.change(input, { target: { value: 'beta' } });
      vi.advanceTimersByTime(200);
      expect(announce).not.toHaveBeenCalled(); // 400 ms since 'b', 200 since 'beta'
      vi.advanceTimersByTime(200);
      expect(announce).toHaveBeenCalledTimes(1); // one settled announcement
      expect(announce).toHaveBeenCalledWith('1 row matches.');
      fireEvent.change(input, { target: { value: 'zzz' } });
      vi.advanceTimersByTime(400);
      expect(announce).toHaveBeenLastCalledWith('No rows match “zzz”.');
      expect(screen.getByText(/no rows match/i).getAttribute('role')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a custom textOf projection matches text sortValue cannot see', () => {
    render(
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id}
        filterable={{ placeholder: 'Filter…', textOf: (r) => `${r.name} ${r.id === '2' ? 'special' : ''}` }} />,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter…' }), { target: { value: 'special' } });
    expect(screen.getByText('Beta LLC')).toBeTruthy();
    expect(screen.queryByText('Alpha Corp')).toBeNull();
  });
});

describe('DataTable stacked headers', () => {
  it('glues a spaced connector to the preceding word with a non-breaking space so it cannot orphan', () => {
    const { container } = render(<DataTable<Row> rows={rows} rowKey={rowKey} columns={cols} stackHeaders />);
    const texts = headerTexts(container);
    // the space BEFORE the connector becomes U+00A0; the space after stays ordinary
    expect(texts).toContain(`Compliance${NBSP}/ legislative risk`);
    expect(texts).toContain(`Intake${NBSP}& evidence`);
    // a title with no spaced connector is untouched (no stray nbsp)
    expect(texts).toContain('Return on investment');
  });

  it('leaves headers verbatim (ordinary spaces, no nbsp) when stackHeaders is off', () => {
    const { container } = render(<DataTable<Row> rows={rows} rowKey={rowKey} columns={cols} />);
    const texts = headerTexts(container);
    expect(texts).toContain('Compliance / legislative risk');
    expect(texts).toContain('Intake & evidence');
    expect(texts.join('')).not.toContain(NBSP);
  });
});

describe('R3 (CSM review follow-up) — null sortValue sinks LAST in BOTH directions', () => {
  const rows = [
    { id: 'b', when: '2026-02-01' },
    { id: 'none', when: null },
    { id: 'a', when: '2026-01-01' },
  ];
  const cols = [{
    key: 'when', header: 'When',
    render: (r: { id: string; when: string | null }) => r.when ?? '—',
    sortValue: (r: { id: string; when: string | null }) => r.when,
  }];
  const ids = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('tbody tr td:first-child')).map((td) => td.textContent ?? '');

  it('ascending: dated rows in order, the null row LAST (never first)', () => {
    const { container } = render(
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id}
        initialSort={{ key: 'when', dir: 'asc' }} />,
    );
    expect(ids(container)).toEqual(['2026-01-01', '2026-02-01', '—']);
  });

  it('descending: the null row STILL last — "no value" is not a far-future value', () => {
    const { container } = render(
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id}
        initialSort={{ key: 'when', dir: 'desc' }} />,
    );
    expect(ids(container)).toEqual(['2026-02-01', '2026-01-01', '—']);
  });
});
