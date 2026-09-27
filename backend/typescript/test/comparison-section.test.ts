/**
 * ADR 0485 — the `comparison` CMS section type (a capability matrix). Pure unit
 * test over `validateSection`: axis bounds, cell scrubbing, highlight-column
 * clamping, and the required-field failures on full (non-partial) validation.
 */
import { describe, expect, it } from 'vitest';
import { validateSection, sanitizeSectionOverlay, type SectionType } from '../src/features/cms/cmsService.js';

const data = (raw: object): Record<string, unknown> =>
  validateSection(raw).data;

const matrix = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  data({
    type: 'comparison',
    data: {
      heading: 'Compare',
      columns: ['OpenWOP', 'n8n'],
      rows: [{ label: 'Replay + fork', cells: ['✓', '✗'] }],
      highlightColumn: 0,
      legend: 'L',
      note: 'N',
      ...over,
    },
  });

describe('comparison section — happy path', () => {
  it('keeps columns, rows, highlightColumn, legend, note', () => {
    const d = matrix();
    expect(d.columns).toEqual(['OpenWOP', 'n8n']);
    expect(d.rows).toEqual([{ label: 'Replay + fork', cells: ['✓', '✗'] }]);
    expect(d.highlightColumn).toBe(0);
    expect(d.legend).toBe('L');
    expect(d.note).toBe('N');
  });

  it('is a registered section type', () => {
    // Type-level assertion the union carries it (compile guard).
    const t: SectionType = 'comparison';
    expect(t).toBe('comparison');
  });
});

describe('comparison section — required fields (full validation)', () => {
  it('rejects an empty columns list', () => {
    expect(() => validateSection({ type: 'comparison', data: { columns: [], rows: [{ label: 'x', cells: [] }] } }))
      .toThrow(/columns needs at least one/);
  });
  it('rejects an empty rows list', () => {
    expect(() => validateSection({ type: 'comparison', data: { columns: ['A'], rows: [] } }))
      .toThrow(/rows needs at least one/);
  });
  it('drops a row with a blank label (then fails if none remain)', () => {
    // A blank-label row is filtered out; with it gone there are zero rows → throw.
    expect(() => validateSection({ type: 'comparison', data: { columns: ['A'], rows: [{ label: '  ', cells: ['✓'] }] } }))
      .toThrow(/rows needs at least one/);
  });
});

describe('comparison section — bounds + scrubbing', () => {
  it('caps columns at MAX.compareCols (8)', () => {
    const cols = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const d = matrix({ columns: cols });
    expect((d.columns as string[]).length).toBe(8);
  });

  it('caps rows at MAX.compareRows (24)', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ label: `r${i}`, cells: ['✓'] }));
    const d = matrix({ rows });
    expect((d.rows as unknown[]).length).toBe(24);
  });

  it('caps a row’s cells at MAX.compareCols (8)', () => {
    const cells = Array.from({ length: 20 }, () => '✓');
    const d = matrix({ columns: ['A'], rows: [{ label: 'r', cells }] });
    expect(((d.rows as { cells: string[] }[])[0].cells).length).toBe(8);
  });

  it('drops highlightColumn when out of range', () => {
    expect(matrix({ highlightColumn: 9 }).highlightColumn).toBeUndefined();
    expect(matrix({ highlightColumn: -1 }).highlightColumn).toBeUndefined();
  });

  it('bounds an over-long cell to MAX.cell (80)', () => {
    const long = 'ok '.repeat(60); // 180 chars of realistic spaced text (not a scrub-triggering blob)
    const d = matrix({ columns: ['A'], rows: [{ label: 'r', cells: [long] }] });
    const cell = (d.rows as { cells: string[] }[])[0].cells[0];
    expect(cell.length).toBeLessThanOrEqual(80);
    expect(cell.length).toBeGreaterThan(0);
  });

  it('coerces non-string cells to empty (no HTML/objects survive)', () => {
    const d = matrix({ columns: ['A', 'B'], rows: [{ label: 'r', cells: [{ x: 1 }, 42] }] });
    expect((d.rows as { cells: string[] }[])[0].cells).toEqual(['', '']);
  });
});

describe('comparison section — partial (localization) overlay', () => {
  it('does not require columns/rows in an overlay', () => {
    const overlay = sanitizeSectionOverlay('comparison', { heading: 'Comparação' });
    expect(overlay.heading).toBe('Comparação');
    expect(overlay.columns).toBeUndefined();
    expect(overlay.rows).toBeUndefined();
  });
});
