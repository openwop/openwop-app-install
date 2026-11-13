/**
 * ADR 1112 P1 — scheduleSim's one model and its replay. Each case is behaviour seen in
 * the rendered section, so it ran red on the old live clock before the change:
 *  - the replay stops at the finish (the old clock never ended: an unanswered decision
 *    pushed the finish out a day per day);
 *  - a lead time is counted back from the lock only when the lock is the day the item is
 *    needed on site (`back`); otherwise the lock is the decide-by date;
 *  - a decision whose lead time is unknown is dated to its lock, labelled, and can be late
 *    (it used to be exempt);
 *  - the detail opens on the first milestone that owns a decision;
 *  - the summary names each missed lock, the decision that held it longest and its rework;
 *  - during the replay a decision already made reads "Decided";
 *  - under reduced motion "Next missed lock" steps to the earliest missed lock ahead, then the finish;
 *  - an author's edit in the Page Builder (new milestones and decisions) reopens the detail.
 *
 * Sabotage, each restored, each red: subtract the lead with `back` unset; drop the five
 * approval days; exempt an unknown lead again; let the clock run past the finish; focus
 * milestones[0]; name the last late decision as the driver; disable "Decided"; make the
 * step jump to the finish; keep the picked focus across an edit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

const show = (data: Record<string, unknown>) => render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'scheduleSim', data } as Section} mode="public" /></MemoryRouter>);

const data = {
  startDate: '2027-01-04',
  milestones: [
    { id: 'kick', label: 'Kickoff', startWeek: 0, weeks: 1 },
    { id: 'rough', label: 'Rough-in', startWeek: 1, weeks: 3, floatDays: 0, rework: 'Open the walls' },
    { id: 'tile', label: 'Tile', startWeek: 4, weeks: 2, floatDays: 0 },
  ],
  decisions: [
    { id: 'valve', title: 'Shower valve', milestone: 'rough', leadDays: 28, lockWeek: 4, options: [{ label: 'Two weeks late', delayDays: 14 }] },
    { id: 'tub', title: 'Freestanding tub', milestone: 'rough', leadDays: 28, lockWeek: 10, back: true, options: [{ label: 'A week late', delayDays: 7 }] },
    { id: 'stone', title: 'Imported stone', milestone: 'tile', leadUnknown: true, lockWeek: 6, options: [{ label: 'Three weeks late', delayDays: 21 }] },
  ],
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const detail = (): HTMLElement => {
  const el = document.querySelector('.fp-psim__detail');
  if (!(el instanceof HTMLElement)) throw new Error('no detail panel');
  return el;
};

describe('ADR 1112 P1 — scheduleSim', () => {
  it('opens on the first milestone that owns a decision', () => {
    show(data);
    expect(within(detail()).getByRole('heading', { level: 3 }).textContent).toBe('Rough-in');
  });

  it('counts the lead time back from the lock only when the lock is the day it is needed on site', () => {
    show(data);
    const text = detail().textContent ?? '';
    // valve: lock week 4 is the decide-by date (Feb 1, 2027).
    expect(text).toMatch(/Shower valve.*Decide by Feb 1, 2027/);
    // tub: needed on site in week 10 (day 70), so 28 + 5 days earlier: day 37, Feb 10.
    expect(text).toMatch(/Freestanding tub.*Decide by Feb 10, 2027.*4-week lead, counted back from the lock/);
  });

  it('dates an unknown lead time to its lock, labels it, and lets it be late', () => {
    show(data);
    fireEvent.click(screen.getByRole('button', { name: /Tile/ }));
    expect(detail().textContent).toMatch(/Imported stone.*Decide by Feb 15, 2027.*Lead time not known/);
    fireEvent.change(screen.getByRole('combobox', { name: 'How late: Imported stone' }), { target: { value: '21' } });
    expect(document.querySelector('.fp-psim__summary')?.textContent).toContain('21 days later');
  });

  it('names each missed lock, the decision that held it longest, and its rework', () => {
    show(data);
    // Two late decisions in one milestone: the longer one is named, wherever it sits in the list.
    fireEvent.change(screen.getByRole('combobox', { name: 'How late: Shower valve' }), { target: { value: '14' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'How late: Freestanding tub' }), { target: { value: '7' } });
    const missed = document.querySelector('.fp-psim__missed');
    expect(missed?.textContent).toMatch(/Rough-in.*14 days.*Held longest by Shower valve.*Open the walls/);
  });

  it('reads "Decided" for a decision the replay has passed, and not before', () => {
    show(data);
    const chip = (): string => [...detail().querySelectorAll('.fp-psim__decision')].find((li) => li.textContent?.includes('Shower valve'))?.querySelector('.fp-psim__chip')?.textContent ?? '';
    expect(chip()).toBe('On time');
    fireEvent.click(screen.getByRole('button', { name: 'Play the schedule' }));
    act(() => { vi.advanceTimersByTime(600 * 3); }); // day 21: valve (day 28) not yet made
    expect(chip()).toBe('On time');
    act(() => { vi.advanceTimersByTime(600 * 2); }); // day 35
    expect(chip()).toBe('Decided on time');
  });

  it('under reduced motion, steps to the earliest missed lock ahead, then the finish', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'reduce');
    try {
      show({ ...data, milestones: data.milestones.map((m) => (m.id === 'tile' ? { ...m, rework: 'Re-tile' } : m)) });
      expect(screen.queryByRole('button', { name: 'Play the schedule' })).toBeNull();
      fireEvent.change(screen.getByRole('combobox', { name: 'How late: Shower valve' }), { target: { value: '14' } });
      fireEvent.click(screen.getByRole('button', { name: /Tile/ }));
      fireEvent.change(screen.getByRole('combobox', { name: 'How late: Imported stone' }), { target: { value: '21' } });
      const today = (): string | null | undefined => document.querySelector('.fp-psim__summary .fp-psim__v')?.textContent;
      fireEvent.click(screen.getByRole('button', { name: 'Next missed lock' }));
      expect(today()).toBe('Jan 25, 2027'); // Rough-in, week 1 + 14 days
      expect(within(detail()).getByRole('heading', { level: 3 }).textContent).toBe('Rough-in');
      expect(screen.getByRole('status').textContent).toMatch(/Missed lock: Rough-in/);
      fireEvent.click(screen.getByRole('button', { name: 'Next missed lock' }));
      expect(today()).toBe('Mar 8, 2027'); // Tile, week 4 + Rough-in's 14 + its own 21
      fireEvent.click(screen.getByRole('button', { name: 'Go to the finish' }));
      expect(screen.getByRole('status').textContent).toMatch(/^Finished on /);
      expect(document.activeElement?.textContent).toBe('Restart');
    } finally {
      document.documentElement.removeAttribute('data-reduce-motion');
    }
  });

  it('under reduced motion, "Go to the finish" with nothing late leaves focus on Restart', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'reduce');
    try {
      show(data);
      const go = screen.getByRole('button', { name: 'Go to the finish' });
      go.focus();
      fireEvent.click(go);
      expect(document.activeElement?.textContent).toBe('Restart');
    } finally {
      document.documentElement.removeAttribute('data-reduce-motion');
    }
  });

  it('reopens the detail when an author adds milestones and decisions in the Page Builder', () => {
    const view = show({ milestones: [], decisions: [] });
    expect(document.querySelector('.fp-psim__detail')).toBeNull();
    view.rerender(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'scheduleSim', data } as Section} mode="public" /></MemoryRouter>);
    expect(within(detail()).getByRole('heading', { level: 3 }).textContent).toBe('Rough-in');
  });

  it('the replay crosses the schedule and stops at the finish', () => {
    show({ ...data, startMode: 'live' });
    fireEvent.click(screen.getByRole('button', { name: /^(Play the schedule|Start the clock)$/ }));
    act(() => { vi.advanceTimersByTime(600 * 200); });
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    const summary = document.querySelector('.fp-psim__summary');
    const values = [...(summary?.querySelectorAll('.fp-psim__v') ?? [])].map((v) => v.textContent);
    expect(values[0]).toBe(values[1]); // the project date has reached the finish, and stays there
    expect(values[1]).toBe('Feb 15, 2027');
  });
});
