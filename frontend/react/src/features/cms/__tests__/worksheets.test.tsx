/**
 * ADR 1105 P1 — the margin and allowance worksheets on the page.
 *
 * The authored figures are starting values the reader edits; the result
 * recomputes; a blank input shows "No figure", never a guess; a line under its
 * allowance reads "Within" and is not netted against a line over; every input
 * has a label; the table keeps explicit roles (WebKit drops native table
 * semantics once the cells are restyled below 640px).
 *
 * Sabotage witnesses: netting lines under against lines over, reading a blank as
 * 0, dropping the explicit table roles or an input's label, or ignoring the
 * authored currency each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const mount = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;

describe('marginCalc (ADR 1105 D3)', () => {
  it('works out price and margin from the authored figures, and follows edits', () => {
    const c = mount({ sectionId: 'm', type: 'marginCalc', data: { heading: 'Price it', cost: 4000, markup: 25, currency: 'USD' } });
    const values = (): string[] => [...c.querySelectorAll('.fp-calc__v')].map((n) => n.textContent ?? '');
    expect(values()).toEqual(['$5,000.00', '20%', 'No figure']);
    fireEvent.change(screen.getByLabelText('Markup, in percent'), { target: { value: '' } });
    expect(values().slice(0, 2)).toEqual(['No figure', 'No figure']);
    fireEvent.change(screen.getByLabelText('Target margin, in percent'), { target: { value: '30' } });
    expect(values()[2]).toBe('42.9%');
  });
});

describe('allowanceGap (ADR 1105 D4)', () => {
  const data = { heading: 'Allowances', currency: 'USD', lines: [{ name: 'Tile', allowance: 8000, specified: 9500 }, { name: 'Lighting', allowance: 6000, specified: 5200 }, { name: 'Fixtures', allowance: 4000 }] };

  it('totals the overruns only, and leaves a line without a figure out', () => {
    const c = mount({ sectionId: 'g', type: 'allowanceGap', data });
    const over = [...c.querySelectorAll('td.fp-gap__over')].map((n) => n.textContent);
    expect(over).toEqual(['$1,500.00', 'Within', 'No figure']);
    expect(c.querySelector('.fp-calc__result .fp-calc__v')!.textContent).toBe('$1,500.00');
    expect(c.querySelector('.fp-calc__result .fp-calc__why')!.textContent).toBe('1 of 3 lines run over. Lines under their allowance are not netted against them. 1 line has no figure and is left out.');
    fireEvent.change(screen.getByLabelText('Fixtures: Expected'), { target: { value: '4600' } });
    expect(c.querySelector('.fp-calc__result .fp-calc__v')!.textContent).toBe('$2,100.00');
  });

  it('follows an author\'s edit to the figures (the Page Builder preview)', () => {
    const view = render(<MemoryRouter><RenderSection section={{ sectionId: 'g', type: 'allowanceGap', data }} mode="public" /></MemoryRouter>);
    const more = { ...data, lines: [...data.lines, { name: 'Hardware', allowance: 500, specified: 900 }] };
    view.rerender(<MemoryRouter><RenderSection section={{ sectionId: 'g', type: 'allowanceGap', data: more }} mode="public" /></MemoryRouter>);
    expect(view.container.querySelector('.fp-calc__result .fp-calc__v')!.textContent).toBe('$1,900.00');
  });

  it('labels every input and keeps explicit table roles', () => {
    const c = mount({ sectionId: 'g', type: 'allowanceGap', data });
    for (const input of c.querySelectorAll('input')) expect(input.getAttribute('aria-label')).toMatch(/^(Tile|Lighting|Fixtures): (Allowance|Expected)$/);
    // The ATTRIBUTES, not the computed roles: jsdom (and Chrome) derive these
    // from the native elements, so only the explicit attribute survives WebKit.
    expect(c.querySelector('table')!.getAttribute('role')).toBe('table');
    expect([...c.querySelectorAll('tbody th[role="rowheader"]')].map((h) => h.textContent)).toEqual(['Tile', 'Lighting', 'Fixtures']);
    expect(c.querySelectorAll('tr[role="row"]')).toHaveLength(4);
    expect(c.querySelectorAll('td[role="cell"][data-label]')).toHaveLength(9);
    const css = readFileSync(join(__dirname, '..', 'designSections.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 640px\) \{[^@]*\.fp-gap__table td::before \{ content: attr\(data-label\);/);
    // One column until 1024px: two auto-fit tracks squeezed the ~420px table into the result card.
    expect(css).toMatch(/\.fp-gap \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/@media \(min-width: 1024px\) \{ \.fp-gap \{ grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\); \} \}/);
  });
});
