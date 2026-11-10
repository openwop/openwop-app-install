/**
 * The decision simulator (scheduleSim). Pins the arithmetic: float absorbs a
 * small delay and the excess pushes every later milestone; a late prerequisite
 * makes its dependant late; an unknown lead time is never dated or counted late;
 * a preset applies its largest matching rule. In the browser: the what-if mode
 * moves the finish date and names the rework, and the live clock makes an
 * unanswered decision late. Sabotage: drop float, ignore dependsOn, or date an
 * unknown lead time.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { presetDelay, readProject, runProject } from '../ProjectSimulator.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);
const show = (section: Section) => render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);

const data = {
  milestones: [
    { id: 'a', label: 'Rough-in', startWeek: 0, weeks: 2, floatDays: 5, rework: 'Open the walls' },
    { id: 'b', label: 'Tile', startWeek: 2, weeks: 2, floatDays: 0 },
  ],
  decisions: [
    { id: 'valve', title: 'Shower valve', milestone: 'a', kind: 'selection', decider: 'Owner', leadDays: 0, lockWeek: 2, options: [{ label: 'Two weeks late', delayDays: 14 }] },
    { id: 'trim', title: 'Trim kit', milestone: 'a', kind: 'selection', leadDays: 0, lockWeek: 3, dependsOn: ['valve'], options: [{ label: 'Late', delayDays: 7 }] },
    { id: 'tile', title: 'Floor tile', milestone: 'b', kind: 'selection', leadDays: 0, lockWeek: 4, dependsOn: ['valve'], options: [{ label: 'A week late', delayDays: 7 }] },
    { id: 'mystery', title: 'Imported stone', milestone: 'b', kind: 'selection', leadUnknown: true, options: [{ label: 'Late', delayDays: 30 }] },
  ],
};

describe('runProject', () => {
  const { milestones, decisions } = readProject(data);
  it('is on schedule with no delay', () => {
    const r = runProject(milestones, decisions, () => 0);
    expect(r.end).toBe(28);
    expect(r.end).toBe(r.baseEnd);
  });
  it('float absorbs part of a delay; the excess pushes every later milestone', () => {
    const r = runProject(milestones, decisions, (d) => (d.id === 'valve' ? 12 : 0));
    expect(r.rows[0]!.slip).toBe(7);
    expect(r.rows[1]!.start).toBe(21);
    expect(r.end).toBe(35);
  });
  it('a late prerequisite makes its dependant late, and names it', () => {
    const r = runProject(milestones, decisions, (d) => (d.id === 'valve' ? 20 : 0));
    const trim = r.decisions.get('trim')!;
    expect(trim.blockedBy).toEqual(['valve']);
    expect(trim.late).toBe(13);
  });
  it('never dates or counts late a decision whose lead time is unknown', () => {
    const r = runProject(milestones, decisions, () => 90);
    const mystery = r.decisions.get('mystery')!;
    expect(mystery.dated).toBe(false);
    expect(mystery.late).toBe(0);
  });
  it('a lead time longer than the runway means decide at kickoff, not late on day one', () => {
    const ms = [{ id: 'a', label: 'Shell', startWeek: 0, weeks: 4, floatDays: 0, rework: '', items: [] }];
    const [slab] = readProject({ milestones: ms, decisions: [{ id: 'slab', title: 'Stone slab', milestone: 'a', leadDays: 120, lockWeek: 2, options: [{ label: 'x', delayDays: 0 }] }] }).decisions;
    const r = runProject(ms, [slab!], () => 0);
    expect(r.decisions.get('slab')!.decideBy).toBe(0);
    expect(r.end).toBe(r.baseEnd);
  });
  it('an on-time prerequisite never blocks, even one dated after its dependant', () => {
    const ms = [{ id: 'a', label: 'A', startWeek: 0, weeks: 4, floatDays: 0, rework: '', items: [] }];
    const { decisions: decs } = readProject({ milestones: ms, decisions: [
      { id: 'late-lock', title: 'Prereq', milestone: 'a', leadDays: 0, lockWeek: 4, options: [{ label: 'x', delayDays: 0 }] },
      { id: 'early', title: 'Dependant', milestone: 'a', leadDays: 0, lockWeek: 1, dependsOn: ['late-lock'], options: [{ label: 'x', delayDays: 0 }] },
    ] });
    const r = runProject(ms, decs, () => 0);
    expect(r.decisions.get('early')!.late).toBe(0);
    expect(r.end).toBe(r.baseEnd);
  });
  it('a preset applies its largest matching rule', () => {
    const preset = { label: 'Slow owner', description: '', rules: [{ decider: 'Owner', delayDays: 21 }, { kind: 'selection', delayDays: 3 }] };
    expect(presetDelay(preset, decisions[0]!)).toBe(21);
    expect(presetDelay(preset, decisions[2]!)).toBe(3);
  });
});

describe('the section', () => {
  it('what-if: a late answer moves the finish and names the rework', () => {
    show({ sectionId: 's', type: 'scheduleSim', data });
    fireEvent.click(screen.getByRole('button', { name: 'What if…' }));
    expect(screen.getByText('On schedule')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'How late: Shower valve' }), { target: { value: '14' } });
    expect(screen.getByText('9 days later')).toBeTruthy();
    expect(screen.getByText(/Open the walls/)).toBeTruthy();
  });
  it('live: an unanswered decision past its date goes late; deciding stops the clock on it', () => {
    show({ sectionId: 's', type: 'scheduleSim', data });
    const step = screen.getByRole('button', { name: '+1 week' });
    act(() => { fireEvent.click(step); fireEvent.click(step); });
    expect(screen.getAllByText(/days? late/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Decide now' })[0]!);
    expect(screen.getAllByText(/Decided/).length).toBeGreaterThan(0);
  });
});
