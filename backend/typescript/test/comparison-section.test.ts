/**
 * ADR 0485 — the `comparison` CMS section type (a capability matrix). Pure unit
 * test over `validateSection`: axis bounds, cell scrubbing, highlight-column
 * clamping, and the required-field failures on full (non-partial) validation.
 * Tracker: TST-CGC-2.
 *
 * Red when: a cap (columns 8, rows 24, cells 8, cell text 80) is dropped; the
 * highlight column is bounded by the cap instead of the real column count; a
 * non-string cell survives as text; a blank-label row is kept; an empty
 * columns/rows list stops failing full validation.
 */
import { describe, expect, it } from 'vitest';
import { validateSection, sanitizeSectionOverlay } from '../src/features/cms/cmsService.js';

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
    // The fixture has 2 columns. 2 (== columns.length) and 5 (past the columns but
    // UNDER the 8-column cap) must both drop — a guard comparing against the cap
    // instead of the real column count keeps 5.
    expect(matrix({ highlightColumn: 2 }).highlightColumn).toBeUndefined();
    expect(matrix({ highlightColumn: 5 }).highlightColumn).toBeUndefined();
    expect(matrix({ highlightColumn: -1 }).highlightColumn).toBeUndefined();
    // Positive control: an in-range non-zero index is kept.
    expect(matrix({ highlightColumn: 1 }).highlightColumn).toBe(1);
  });

  it('bounds an over-long cell to MAX.cell (80)', () => {
    const long = 'ok '.repeat(60); // 180 chars of realistic spaced text (not a scrub-triggering blob)
    const d = matrix({ columns: ['A'], rows: [{ label: 'r', cells: [long] }] });
    const cell = (d.rows as { cells: string[] }[])[0].cells[0];
    // The first 80 characters of the trimmed input, derived by hand.
    expect(cell).toBe('ok '.repeat(26) + 'ok');
    expect(cell).toHaveLength(80);
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

// The compare page's TEXT matrix (myndhyve.ai design, CMP-03/04/05): an opt-in
// `style`. Red when: 'text' is dropped; an unknown style is accepted on the base;
// an overlay with a bad style throws instead of dropping it; an absent style
// starts emitting a value.
describe('comparison section — style', () => {
  it("keeps style 'text' and emits nothing when absent", () => {
    expect(matrix({ style: 'text' }).style).toBe('text');
    expect(matrix({ style: ' text ' }).style).toBe('text');
    expect('style' in matrix()).toBe(false);
  });

  it('refuses an unknown style on the base, and drops it from an overlay', () => {
    expect(() => matrix({ style: 'bold' })).toThrow(/comparison\.style must be one of: text/);
    const overlay = sanitizeSectionOverlay('comparison', { heading: 'Comparação', style: 'bold' }) as Record<string, unknown>;
    expect(overlay.heading).toBe('Comparação');
    expect(overlay.style).toBeUndefined();
  });
});
