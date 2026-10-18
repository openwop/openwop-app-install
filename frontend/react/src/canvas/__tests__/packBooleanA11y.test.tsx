/**
 * CPKU-2 — GenericPackContentView rendered boolean fields as a bare `✓`/`—`
 * glyph with NO accessible name, so a screen reader announced "check mark" / a
 * bare dash instead of the field's true/false state. This pins an accessible
 * Yes/No name (localized) with the decorative glyph marked aria-hidden.
 *
 * Vacuity guard: asserting the GLYPH renders proves nothing about a11y (it
 * already did). The load-bearing assertions are the accessible TEXT (Yes/No) and
 * that the glyph is aria-hidden so it is not double-announced.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { buildPackDefinition, parsePackEditorHints } from '../packDefinition.js';

const HINTS = parsePackEditorHints({
  docNameKey: 'title',
  collections: [{
    key: 'items', label: 'Items', max: 200, min: 1, itemLabelField: 'text',
    adders: [{ id: 'item', label: 'Checklist item', defaults: { text: 'New item', done: false } }],
    fields: [
      { name: 'text', type: 'string', label: 'Text', required: true },
      { name: 'done', type: 'boolean', label: 'Done' },
    ],
  }],
})!;

afterEach(cleanup);

describe('CPKU-2 — pack boolean fields have an accessible Yes/No name', () => {
  it('renders localized Yes/No text (not just a ✓/— glyph), with the glyph aria-hidden', () => {
    const def = buildPackDefinition('canvas.checklist', HINTS);
    const Renderer = def.Renderer!;
    render(<Renderer content={JSON.stringify({ items: [{ text: 'Milk', done: true }, { text: 'Bread', done: false }] })} />);

    // Load-bearing, PER ROW: the true row reads Yes and the false row reads No.
    // Asserting "Yes and No both exist somewhere" could not see the mapping
    // swapped — one true + one false row is a symmetric fixture
    // (w46g2-pba-swap was vacuous in round 1).
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const [milk, bread] = rows as [HTMLElement, HTMLElement];
    expect(milk.textContent).toContain('Milk');
    expect(bread.textContent).toContain('Bread');
    const yes = within(milk).getByText('Yes');
    expect(within(milk).queryByText('No')).toBeNull();
    const no = within(bread).getByText('No');
    expect(within(bread).queryByText('Yes')).toBeNull();
    // The accessible text itself is NOT hidden from assistive tech.
    expect(yes.closest('[aria-hidden="true"]')).toBeNull();
    expect(no.closest('[aria-hidden="true"]')).toBeNull();

    // The decorative glyph is aria-hidden so a screen reader doesn't ALSO read
    // "check mark"/"dash" alongside the Yes/No — and each row carries ITS glyph.
    const glyphs = (row: HTMLElement): (string | null)[] =>
      Array.from(row.querySelectorAll('[aria-hidden="true"]')).map((g) => g.textContent);
    expect(glyphs(milk)).toEqual(['✓']);
    expect(glyphs(bread)).toEqual(['—']);
  });
});
