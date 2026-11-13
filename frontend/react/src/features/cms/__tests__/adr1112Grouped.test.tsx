/**
 * ADR 1112 P2 — scheduleSim grouped by phase, category and role.
 *
 * Pins:
 *  - lateness resolves per decision: its own setting, else its cell's, else the larger of
 *    its role's and the scenario's other rules (CasaVoga's `delayFor`);
 *  - a scenario's role-only rules fill the role controls, so a visitor sees and can change them;
 *  - the grid counts each cell's decisions and its late ones; an open cell lists the first
 *    12, then "Show all", and its own setting moves the finish;
 *  - 1,500 decisions render a small DOM: the grid, and at most 12 rows per open list;
 *  - switching scenario re-fills the role controls; two rules for one role take the larger;
 *  - keyboard: the grid is one tab stop moved by the arrow keys, a cell button says it
 *    expands its panel and opening it moves focus there, and "Show all" moves focus to the
 *    first row it adds;
 *  - a section with no grouping fields renders no grid and no role controls (as before).
 *
 * Sabotage, each restored, each red: cell before own setting; role-only rules not seeded
 * into the controls; no LIST_FIRST cap; counts that ignore lateness.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';
import { delayFor, presetRoles, readProject, type PPreset } from '../ProjectSimulator.js';

afterEach(cleanup);
const show = (data: Record<string, unknown>) => render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'scheduleSim', data } as Section} mode="public" /></MemoryRouter>);

const phases = [{ key: 'design', label: 'Design' }, { key: 'build', label: 'Build' }];
const categories = [{ key: 'rooms', label: 'Rooms' }, { key: 'mep', label: 'MEP' }];
const roles = [{ key: 'client', label: 'Client' }, { key: 'builder', label: 'Builder' }];
const milestones = [
  { id: 'm1', label: 'Design lock', startWeek: 0, weeks: 4, floatDays: 0, rework: 'Redraw the plans' },
  { id: 'm2', label: 'Rough-in', startWeek: 4, weeks: 4, floatDays: 0 },
];
const many = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({
  id: `d${i}`, title: `Decision ${i}`, milestone: i % 2 === 0 ? 'm1' : 'm2', lockWeek: i % 2 === 0 ? 2 : 6,
  phase: i % 2 === 0 ? 'design' : 'build', category: i % 4 < 2 ? 'rooms' : 'mep', role: i % 3 === 0 ? 'client' : 'builder', ...extra,
}));
const data = (decisions: Record<string, unknown>[], presets?: PPreset[]) => ({ startDate: '2027-01-04', phases, categories, roles, milestones, decisions, ...(presets ? { presets } : {}) });

describe('ADR 1112 P2 — delayFor', () => {
  const { decisions } = readProject(data(many(4)));
  const x = decisions[0]!; // design · rooms · client
  const preset: PPreset = { label: 'p', description: '', rules: [{ role: 'client', delayDays: 7 }, { phase: 'design', delayDays: 14 }] };
  it('own setting, else the cell, else the larger of the role and the other rules', () => {
    expect(delayFor(x, preset, { roles: { client: 7 }, cells: {}, one: {} })).toBe(14); // phase rule beats the role
    expect(delayFor(x, preset, { roles: { client: 21 }, cells: {}, one: {} })).toBe(21); // the role beats it
    expect(delayFor(x, preset, { roles: { client: 21 }, cells: { 'design|rooms': 3 }, one: {} })).toBe(3);
    expect(delayFor(x, preset, { roles: { client: 21 }, cells: { 'design|rooms': 3 }, one: { d0: 0 } })).toBe(0);
  });
});

describe('ADR 1112 P2 — the grouped view', () => {
  it('a scenario\'s role-only rules fill the role controls', () => {
    show(data(many(4), [{ label: 'Slow client', description: '', rules: [{ role: 'client', delayDays: 14 }] }]));
    const client = screen.getByRole('combobox', { name: 'Client' }) as HTMLSelectElement;
    expect(client.value).toBe('14');
    // Client decisions sit in both milestones, and neither has float: each slips 14 days.
    expect(document.querySelector('.fp-psim__summary')?.textContent).toMatch(/28 days later/);
    fireEvent.change(client, { target: { value: '0' } });
    expect(document.querySelector('.fp-psim__summary')?.textContent).toMatch(/On schedule/);
  });

  it('counts each cell and its late decisions; an open cell shows 12, then all, and its setting moves the finish', () => {
    show(data(many(40)));
    const cell = screen.getByRole('button', { name: 'Design, Rooms: 10 decisions, 0 late' });
    fireEvent.click(cell);
    const panel = (): Element => document.querySelectorAll('.fp-psim__cells .fp-psim__detail')[0] as Element;
    expect(panel().querySelectorAll('.fp-psim__decision')).toHaveLength(10);
    fireEvent.change(screen.getByRole('combobox', { name: 'How late: this cell' }), { target: { value: '21' } });
    expect(screen.getByRole('button', { name: 'Design, Rooms: 10 decisions, 10 late' })).toBeTruthy();
    expect(document.querySelector('.fp-psim__summary')?.textContent).toMatch(/21 days later/);
    cleanup();
    show(data(many(120)));
    fireEvent.click(screen.getByRole('button', { name: 'Design, Rooms: 30 decisions, 0 late' }));
    expect(panel().querySelectorAll('.fp-psim__decision')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 30' }));
    expect(panel().querySelectorAll('.fp-psim__decision')).toHaveLength(30);
  });

  it('renders 1,500 decisions as a grid and at most 12 rows per list', () => {
    show(data(many(1_500)));
    expect(document.querySelectorAll('.fp-psim__decision')).toHaveLength(12); // the open milestone's first 12
    expect(document.querySelectorAll('.fp-psim__cellbtn')).toHaveLength(4);
  });

  it('switching scenario re-fills the role controls; two rules for one role take the larger', () => {
    expect(presetRoles({ label: 'p', description: '', rules: [{ role: 'client', delayDays: 21 }, { role: 'client', delayDays: 7 }] })).toEqual({ client: 21 });
    show(data(many(4), [
      { label: 'Slow client', description: '', rules: [{ role: 'client', delayDays: 14 }] },
      { label: 'Slow builder', description: '', rules: [{ role: 'builder', delayDays: 7 }] },
    ]));
    fireEvent.click(screen.getByRole('button', { name: 'Slow builder' }));
    expect((screen.getByRole('combobox', { name: 'Client' }) as HTMLSelectElement).value).toBe('0');
    expect((screen.getByRole('combobox', { name: 'Builder' }) as HTMLSelectElement).value).toBe('7');
  });

  it('keyboard: one tab stop, arrows move, opening a cell focuses its panel, Show all focuses row 13', () => {
    show(data(many(120)));
    const cells = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.fp-psim__cellbtn')];
    expect(cells().filter((b) => b.tabIndex === 0)).toHaveLength(1);
    const first = cells()[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells()[1]);
    expect(cells()[1]?.tabIndex).toBe(0);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cells()[3]);
    fireEvent.click(cells()[0]!);
    expect(cells()[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(cells()[0]?.getAttribute('aria-controls') ?? '')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Design · Rooms');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 30' }));
    const rows = document.querySelectorAll('.fp-psim__cells .fp-psim__decision');
    expect(document.activeElement).toBe(rows[12]?.querySelector('select'));
  });

  it('mints preview ids that never collide with an authored one', () => {
    const { decisions } = readProject({ milestones, decisions: [{ title: 'No id', milestone: 'm1' }, { id: 'd1', title: 'Authored', milestone: 'm1' }] });
    expect(decisions.map((x) => x.id)).toEqual(['d2', 'd1']);
  });

  it('"Show all" focuses a row in its own simulator when two share a page', () => {
    render(<MemoryRouter>
      <RenderSection section={{ sectionId: 'a', type: 'scheduleSim', data: data(many(120)) } as Section} mode="public" />
      <RenderSection section={{ sectionId: 'b', type: 'scheduleSim', data: data(many(120)) } as Section} mode="public" />
    </MemoryRouter>);
    const sims = document.querySelectorAll('section.fp-psim');
    const second = sims[1] as HTMLElement;
    // The same cell open in both, so both hold a list with the same id.
    for (const sim of sims) fireEvent.click(sim.querySelector<HTMLButtonElement>('.fp-psim__cellbtn')!);
    fireEvent.click([...second.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show all 30')!);
    expect(second.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe('SELECT');
  });

  it('an ungrouped section renders no grid and no role controls', () => {
    show({ milestones, decisions: [{ id: 'a', title: 'Tile', milestone: 'm1', options: [{ label: 'Late', delayDays: 7 }] }] });
    expect(document.querySelector('.fp-psim__cells')).toBeNull();
    expect(document.querySelector('.fp-psim__roles')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'How late: Tile' })).toBeTruthy();
  });
});
