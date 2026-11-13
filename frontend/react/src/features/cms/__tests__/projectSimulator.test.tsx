/**
 * The decision simulator (scheduleSim). Pins the arithmetic: float absorbs a
 * small delay and the excess pushes every later milestone; a late prerequisite
 * makes its dependant late;
 * a preset applies its largest matching rule. In the browser: a late setting
 * moves the finish date and names the rework. Sabotage: drop float, or ignore
 * dependsOn. (The live clock and the unknown-lead exemption are gone: ADR 1112,
 * pinned in adr1112Schedule.test.tsx.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { MAX_AXIS_LABELS, monthTicks, presetDelay, readProject, runSchedule } from '../ProjectSimulator.js';
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

describe('runSchedule', () => {
  const { milestones, decisions } = readProject(data);
  it('is on schedule with no delay', () => {
    const r = runSchedule(milestones, decisions, () => 0);
    expect(r.end).toBe(28);
    expect(r.end).toBe(r.baseEnd);
  });
  it('float absorbs part of a delay; the excess pushes every later milestone', () => {
    const r = runSchedule(milestones, decisions, (d) => (d.id === 'valve' ? 12 : 0));
    expect(r.rows[0]!.slip).toBe(7);
    expect(r.rows[1]!.start).toBe(21);
    expect(r.end).toBe(35);
  });
  it('a late prerequisite makes its dependant late, and names it', () => {
    const r = runSchedule(milestones, decisions, (d) => (d.id === 'valve' ? 20 : 0));
    const trim = r.decisions.get('trim')!;
    expect(trim.blockedBy).toEqual(['valve']);
    expect(trim.late).toBe(13);
  });
  it('dates a decision whose lead time is unknown to its milestone, and lets it be late (ADR 1112 D1)', () => {
    const r = runSchedule(milestones, decisions, (d) => (d.id === 'mystery' ? 9 : 0));
    const mystery = r.decisions.get('mystery')!;
    expect(mystery.decideBy).toBe(14);
    expect(mystery.late).toBe(9);
    expect(r.rows[1]?.driver).toBe('mystery');
  });
  it('a lead time longer than the runway means decide at kickoff, not late on day one', () => {
    const ms = [{ id: 'a', label: 'Shell', startWeek: 0, weeks: 4, floatDays: 0, rework: '', items: [] }];
    const [slab] = readProject({ milestones: ms, decisions: [{ id: 'slab', title: 'Stone slab', milestone: 'a', leadDays: 120, lockWeek: 2, back: true, options: [{ label: 'x', delayDays: 0 }] }] }).decisions;
    const r = runSchedule(ms, [slab!], () => 0);
    expect(r.decisions.get('slab')!.decideBy).toBe(0);
    expect(r.end).toBe(r.baseEnd);
  });
  it('an on-time prerequisite never blocks, even one dated after its dependant', () => {
    const ms = [{ id: 'a', label: 'A', startWeek: 0, weeks: 4, floatDays: 0, rework: '', items: [] }];
    const { decisions: decs } = readProject({ milestones: ms, decisions: [
      { id: 'late-lock', title: 'Prereq', milestone: 'a', leadDays: 0, lockWeek: 4, options: [{ label: 'x', delayDays: 0 }] },
      { id: 'early', title: 'Dependant', milestone: 'a', leadDays: 0, lockWeek: 1, dependsOn: ['late-lock'], options: [{ label: 'x', delayDays: 0 }] },
    ] });
    const r = runSchedule(ms, decs, () => 0);
    expect(r.decisions.get('early')!.late).toBe(0);
    expect(r.end).toBe(r.baseEnd);
  });
  it('a late prerequisite holds its dependant by no more than its own lateness', () => {
    const ms = [{ id: 'a', label: 'A', startWeek: 0, weeks: 4, floatDays: 0, rework: '', items: [] }];
    const { decisions: decs } = readProject({ milestones: ms, decisions: [
      { id: 'pre', title: 'Prereq', milestone: 'a', lockWeek: 3, options: [{ label: 'x', delayDays: 5 }] },
      { id: 'dep', title: 'Dependant', milestone: 'a', lockWeek: 0, dependsOn: ['pre'], options: [{ label: 'x', delayDays: 0 }] },
    ] });
    // pre is made on day 26, 5 days late; dep is due on day 0, so it waits 5 days, not 26.
    const r = runSchedule(ms, decs, (d) => (d.id === 'pre' ? 5 : 0));
    expect(r.decisions.get('dep')).toMatchObject({ made: 5, late: 5, blockedBy: ['pre'] });
  });
  it('dates a prerequisite in a later milestone on that milestone\'s own slip', () => {
    const ms = [
      { id: 'a', label: 'A', startWeek: 0, weeks: 2, floatDays: 0, rework: '', items: [] },
      { id: 'b', label: 'B', startWeek: 2, weeks: 2, floatDays: 0, rework: '', items: [] },
    ];
    const { decisions: decs } = readProject({ milestones: ms, decisions: [
      { id: 'early', title: 'Early', milestone: 'a', lockWeek: 1, options: [{ label: 'x', delayDays: 7 }] },
      { id: 'asked', title: 'Asked early', milestone: 'b', lockWeek: 3, options: [{ label: 'x', delayDays: 0 }] },
      { id: 'mid', title: 'Needs it', milestone: 'a', lockWeek: 1, dependsOn: ['asked'], options: [{ label: 'x', delayDays: 0 }] },
      { id: 'twin', title: 'Same lock', milestone: 'b', lockWeek: 3, options: [{ label: 'x', delayDays: 0 }] },
    ] });
    const r = runSchedule(ms, decs, (d) => (d.id === 'early' ? 7 : 0));
    // A slips 7 days; both B decisions share lock week 3, so both fall due on day 21 + 7.
    expect(r.decisions.get('asked')?.decideBy).toBe(28);
    expect(r.decisions.get('twin')?.decideBy).toBe(28);
  });
  it('finishes where the latest bar ends, even with milestones authored out of start order', () => {
    const ms = [
      { id: 'late', label: 'Late', startWeek: 6, weeks: 2, floatDays: 0, rework: '', items: [] },
      { id: 'first', label: 'First', startWeek: 0, weeks: 2, floatDays: 0, rework: '', items: [] },
    ];
    const { decisions: decs } = readProject({ milestones: ms, decisions: [{ id: 'x', title: 'X', milestone: 'first', lockWeek: 1, options: [{ label: 'x', delayDays: 7 }] }] });
    const r = runSchedule(ms, decs, () => 7);
    expect(r.end).toBe(Math.max(...r.rows.map((row) => row.end)));
    expect(r.end).toBe(56);
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
    expect(screen.getByText('On schedule')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'How late: Shower valve' }), { target: { value: '14' } });
    expect(document.querySelector('.fp-psim__summary')?.textContent).toContain('9 days later');
    expect(document.querySelector('.fp-psim__missed')?.textContent).toMatch(/Open the walls/);
  });
  it('counts the late decisions and, of those, the late orders', () => {
    show({ sectionId: 's', type: 'scheduleSim', data: { ...data, decisions: data.decisions.map((x) => (x.id === 'valve' ? { ...x, leadDays: 21 } : x)) } });
    fireEvent.change(screen.getByRole('combobox', { name: 'How late: Shower valve' }), { target: { value: '14' } });
    // valve is late and orders something; trim waits on it and orders nothing. tile waits on
    // it too, but its own lock is after valve is made, so it is not held.
    expect(document.querySelector('.fp-psim__summary')?.textContent).toContain('2 decisions · 1 order');
  });
});

describe('the month axis (#5779 B6)', () => {
  const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
  const DAY = 86_400_000;

  it('thins a 59-week plan to every other month, anchored on January, with the year on its own field', () => {
    const start = day('2027-03-01');
    const ticks = monthTicks(start, 59 * 7);
    const at = (t: { day: number }): string => new Date(start + t.day * DAY).toISOString().slice(0, 7);
    // Before: every month labelled and "Jan 2028" ran into Feb and Mar at 1280px.
    expect(ticks.map(at)).toEqual(['2027-03', '2027-05', '2027-07', '2027-09', '2027-11', '2028-01', '2028-03']);
    expect(ticks.filter((t) => t.year !== undefined)).toEqual([{ day: Math.round((day('2028-01-01') - start) / DAY), month: 0, year: 2028 }]);
  });

  it('labels every month on a short plan, and never more than the cap on a long one', () => {
    expect(monthTicks(day('2027-03-01'), 26 * 7)).toHaveLength(6);
    const long = monthTicks(day('2027-02-01'), 3 * 365);
    expect(long.length).toBeLessThanOrEqual(MAX_AXIS_LABELS + 1);
    expect(long.filter((t) => t.month === 0).every((t) => t.year !== undefined)).toBe(true); // every January keeps its year
  });

  it('draws the year on a second line inside January\'s tick', () => {
    const { container } = render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'scheduleSim', data: {
      startDate: '2027-11-01',
      milestones: [{ id: 'a', label: 'Design', weeks: 20 }],
    } }} mode="public" /></MemoryRouter>);
    const years = [...container.querySelectorAll('.fp-psim__tick-year')].map((n) => n.textContent);
    expect(years).toEqual(['2028']);
    expect(container.querySelector('.fp-psim__tick-year')?.parentElement?.className).toBe('fp-psim__tick');
  });
});

describe('one view and the summary (#5779 B5, ADR 1112 D3)', () => {
  const data = { startDate: '2027-03-01', milestones: [{ id: 'a', label: 'Design', weeks: 4 }], decisions: [{ id: 'd', title: 'Tile', milestone: 'a', leadDays: 14 }], presets: [{ label: 'Late tile', rules: [{ delayDays: 7 }] }] };
  const mount = (extra: Record<string, unknown>) => render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'scheduleSim', data: { ...data, ...extra } }} mode="public" /></MemoryRouter>);

  it('has no mode to switch: an old startMode opens the same settings and replay', () => {
    for (const startMode of ['whatIf', 'live', undefined]) {
      mount(startMode ? { startMode } : {});
      expect(screen.getByRole('button', { name: 'Late tile' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: 'Play the schedule' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Run the project' })).toBeNull();
      cleanup();
    }
  });

  it('makes the summary sticky only when asked', () => {
    expect(mount({ stickySummary: true }).container.querySelector('.fp-psim__summary--sticky')).not.toBeNull();
    cleanup();
    const plain = mount({});
    expect(plain.container.querySelector('.fp-psim__summary')?.className).toBe('fp-psim__summary');
  });

  it('holds the summary in place from 900px only', () => {
    const css = readFileSync(join(__dirname, '..', 'projectSimulator.css'), 'utf8');
    const rule = css.match(/@media \(min-width: 900px\) \{\s*\.fp-psim__summary--sticky \{([^}]*)\}/);
    expect(rule, 'the sticky rule sits inside the 900px query').not.toBeNull();
    expect(rule![1]).toMatch(/position: sticky; inset-block-start: var\(--public-header-offset\)/);
    // Only the summary is held at 900px; the grouped grid's row headers stick sideways (ADR 1112 P2).
    expect(css.replace(rule![0], '')).not.toMatch(/fp-psim__summary[^{]*\{[^}]*position: sticky/);
  });
});

describe('ADR 1112 D8 — a stored row with repeated ids still renders one row each', () => {
  it('gives a later repeat its own display id, keeping references on the first', () => {
    const { milestones, decisions } = readProject({
      milestones: [{ id: 'm1', label: 'Design' }, { id: 'm1', label: 'Build' }],
      decisions: [{ id: 'a', title: 'Tile', milestone: 'm1' }, { id: 'a', title: 'Tap', milestone: 'm1' }, { id: 'a~2', title: 'Taken', milestone: 'm1' }],
    });
    expect(milestones.map((m) => m.id)).toEqual(['m1', 'm1~2']);
    expect(decisions.map((x) => x.id)).toEqual(['a', 'a~3', 'a~2']);
    expect(decisions.every((x) => x.milestone === 'm1')).toBe(true);
  });
});

