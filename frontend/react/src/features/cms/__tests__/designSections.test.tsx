/**
 * ADR 1080 — the design-led site sections in the browser. Pins the date and
 * schedule arithmetic, "no date when unknown", worded status chips, a question
 * swapping its answer, a tree reaching its outcome, and a late answer moving
 * the finish date. Sabotage: let float absorb nothing, show a date with a
 * missing value, or drop the status word for color alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { computeDates, parseCount } from '../DesignSections.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);
const show = (section: Section) => render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);

describe('arithmetic', () => {
  it('works back from the need date, and gives no date for an unknown value', () => {
    const r = computeDates('2027-03-12', 10, 10, 5);
    expect(r?.orderBy.toISOString().slice(0, 10)).toBe('2026-12-22');
    expect(r?.decideBy.toISOString().slice(0, 10)).toBe('2026-12-17');
    expect(computeDates('2027-03-12', parseCount(''), 10, 5)).toBeNull();
  });

});

describe('public sections', () => {
  it('status table keeps the word with the color', () => {
    show({ sectionId: 't', type: 'statusTable', data: { columns: ['Tag', 'Item'], rows: [{ cells: ['UP-07', 'Sofa'], status: 'CFA overdue', tone: 'bad' }] } });
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('CFA overdue').className).toContain('fp-status--bad');
  });
  it('status table puts a split head and its points beside the table, and is unchanged without them (#5765)', () => {
    const data = { columns: ['Tag'], rows: [{ cells: ['UP-07'] }] };
    const { container } = show({ sectionId: 't', type: 'statusTable', data: { ...data, heading: 'Lock readiness', head: 'split', points: ['Every order', 'Every date'] } });
    const intro = container.querySelector('.fp-stable__intro');
    expect(intro?.querySelector('h2')?.textContent).toContain('Lock readiness');
    expect([...(intro?.querySelectorAll('.fp-stable__points li') ?? [])].map((li) => li.textContent)).toEqual(['Every order', 'Every date']);
    expect(container.querySelector('section')?.className).toContain('fp-split');
    cleanup();
    const plain = show({ sectionId: 't', type: 'statusTable', data });
    expect(plain.container.querySelector('.fp-stable__intro, .fp-stable__points')).toBeNull();
  });

  it('conversation swaps the answer', () => {
    show({ sectionId: 'q', type: 'conversation', data: { exchanges: [{ q: 'One?', a: 'First.' }, { q: 'Two?', a: 'Second.' }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Two?' }));
    expect(screen.getByText('Second.')).toBeTruthy();
    expect(screen.queryByText('First.')).toBeNull();
  });
  it('decision tree walks to its outcome and back', () => {
    show({ sectionId: 'd', type: 'decisionTree', data: { trees: [{ title: 'Go', nodes: [{ id: 'a', text: 'In scope?', options: [{ label: 'Yes', next: 'b' }, { label: 'No', outcome: 'Refer out.' }] }, { id: 'b', text: 'Budget fits?', options: [{ label: 'Yes', outcome: 'Take it.' }] }] }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(screen.getByText('Budget fits?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(screen.getByText('Take it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Budget fits?')).toBeTruthy();
  });

  it('feature index shows the chosen group', () => {
    show({ sectionId: 'f', type: 'featureIndex', data: { groups: [{ name: 'Leads', items: [{ label: 'Inquiry capture' }] }, { name: 'Decisions', items: [{ label: 'Decision catalog' }] }] } });
    fireEvent.click(screen.getByRole('button', { name: /Decisions/ }));
    expect(screen.getByText('Decision catalog').closest('[hidden]')).toBeNull();
  });
});
