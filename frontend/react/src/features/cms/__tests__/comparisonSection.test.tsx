/**
 * ADR 0485 — the public `comparison` section renderer (a capability matrix).
 * Exercises the RENDERED table: a real <table> inside a scrollable, labelled
 * region; capability rows as row-headers; glyph cells that pair the symbol with
 * an sr-only word (never symbol/color alone); and the highlighted (our) column.
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
    const { container } = renderSection(comparisonSection());
    // ✓ → "Yes", ✗ → "No", ~ → "Partial" as visually-hidden text.
    expect(within(container).getAllByText('Yes', { selector: '.sr-only' }).length).toBeGreaterThan(0);
    expect(within(container).getAllByText('No', { selector: '.sr-only' }).length).toBeGreaterThan(0);
    expect(within(container).getAllByText('Partial', { selector: '.sr-only' }).length).toBeGreaterThan(0);
  });

  it('wraps the wide table in a labelled scroll region (page body never scrolls)', () => {
    renderSection(comparisonSection());
    const region = screen.getByRole('region', { name: 'How we compare' });
    expect(region.className).toContain('fp-matrix__scroll');
  });

  it('marks the highlighted column header with the --hl class', () => {
    renderSection(comparisonSection());
    const head = screen.getByRole('columnheader', { name: 'OpenWOP' });
    expect(head.className).toContain('fp-matrix__colhead--hl');
  });

  it('renders the legend + note', () => {
    renderSection(comparisonSection());
    expect(screen.getByText(/ships · ~ partial/)).toBeTruthy();
    expect(screen.getByText(/As of mid-2026/)).toBeTruthy();
  });

  it('renders nothing when there are no rows (degrades, no broken table)', () => {
    const { container } = renderSection(comparisonSection({ rows: [] }));
    expect(container.querySelector('table')).toBeNull();
  });
});
