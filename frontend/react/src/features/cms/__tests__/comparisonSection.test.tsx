/**
 * ADR 0485 — the public `comparison` section renderer (a capability matrix).
 * Exercises the RENDERED table: a real <table> inside a keyboard-scrollable,
 * labelled region; capability rows as row-headers; glyph cells that pair the
 * symbol with an sr-only word bound to THAT cell (never symbol/color alone);
 * and the highlighted column chosen by `highlightColumn`.
 *
 * Sabotage that turns it red: swap the ✓/✗ words in `compareCellAria`;
 * hard-code the highlighted index; drop `role="region"` or the row-header
 * `<th scope="row">`; render a table with no rows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

function comparisonSection(over: Record<string, unknown> = {}): Section {
  return {
    sectionId: 's1',
    type: 'comparison',
    data: {
      heading: 'How we compare',
      columns: ['OpenWOP', 'n8n', 'Zapier'],
      rows: [
        { label: 'Replay + fork', cells: ['✓', '✗', '✗'] },
        { label: 'Cost attribution', cells: ['✓', '~', '~'] },
      ],
      highlightColumn: 0,
      legend: '✓ ships · ~ partial · ✗ not shipped',
      note: 'As of mid-2026, from public docs.',
      ...over,
    },
  };
}

function renderSection(section: Section) {
  return render(
    <MemoryRouter>
      <RenderSection section={section} mode="public" />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('comparison section renderer (ADR 0485)', () => {
  it('renders a table with the product columns as column headers', () => {
    renderSection(comparisonSection());
    expect(screen.getByRole('table')).toBeTruthy();
    for (const c of ['OpenWOP', 'n8n', 'Zapier']) {
      expect(screen.getByRole('columnheader', { name: c })).toBeTruthy();
    }
  });

  it('renders each capability as a row header', () => {
    renderSection(comparisonSection());
    expect(screen.getByRole('rowheader', { name: 'Replay + fork' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Cost attribution' })).toBeTruthy();
  });

  it('pairs each status glyph with an sr-only word (not symbol/color alone)', () => {
    renderSection(comparisonSection());
    // ✓ → "Yes", ✗ → "No", ~ → "Partial", in the SAME cell as its glyph; the
    // glyph itself is hidden from assistive tech so it is not read twice.
    const cellsOf = (label: RegExp): HTMLElement[] => within(screen.getByRole('row', { name: label })).getAllByRole('cell');
    expect(cellsOf(/Replay \+ fork/).map((c) => c.textContent)).toEqual(['✓Yes', '✗No', '✗No']);
    expect(cellsOf(/Cost attribution/).map((c) => c.textContent)).toEqual(['✓Yes', '~Partial', '~Partial']);
    const yes = cellsOf(/Replay \+ fork/)[0]!;
    expect(yes.querySelector('.fp-matrix__mark')?.getAttribute('aria-hidden')).toBe('true');
    expect(yes.querySelector('.sr-only')?.textContent).toBe('Yes');
  });

  it('wraps the wide table in a labelled scroll region (page body never scrolls)', () => {
    renderSection(comparisonSection());
    const region = screen.getByRole('region', { name: 'How we compare' });
    expect(region.querySelector('table')).toBeTruthy();
    // The region scrolls (the CSS hook) and is keyboard-reachable so it can be scrolled.
    expect(region.className).toContain('fp-matrix__scroll');
    expect(region.tabIndex).toBe(0);
  });

  it('names the region from the visible heading (emphasis markers stripped)', () => {
    renderSection(comparisonSection({ heading: 'How we *compare*' }));
    expect(screen.getByRole('region', { name: 'How we compare' })).toBeTruthy();
  });

  it('marks the column named by highlightColumn, and only that one', () => {
    renderSection(comparisonSection({ highlightColumn: 1 }));
    expect(screen.getByRole('columnheader', { name: 'n8n' }).className).toContain('fp-matrix__colhead--hl');
    expect(screen.getByRole('columnheader', { name: 'OpenWOP' }).className).not.toContain('--hl');
    expect(screen.getByRole('columnheader', { name: 'Zapier' }).className).not.toContain('--hl');
  });

  it('renders the legend + note', () => {
    renderSection(comparisonSection());
    expect(screen.getByText(/ships · ~ partial/)).toBeTruthy();
    expect(screen.getByText(/As of mid-2026/)).toBeTruthy();
  });

  it('renders nothing when there are no rows (degrades, no broken table)', () => {
    const { container } = renderSection(comparisonSection({ rows: [] }));
    expect(container.querySelector('table')).toBeNull();
    cleanup();
    const noCols = renderSection(comparisonSection({ columns: [] }));
    expect(noCols.container.querySelector('table')).toBeNull();
  });
});
