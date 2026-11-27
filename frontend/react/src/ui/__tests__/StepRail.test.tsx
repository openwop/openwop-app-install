/**
 * StepRail (ADR 1154 D9) — a path of step LINKS, not a tablist.
 *
 *   - it is a named `nav` holding an ordered list, in the order given;
 *   - every step is a link to its own address;
 *   - only the current step carries `aria-current="step"`, and with no current
 *     step none does;
 *   - each step's state is in the link's name as words, never colour alone.
 *
 * Sabotage: rendering the rail as `role="tablist"` reds the first case; marking
 * every link current reds the third; dropping the state label reds the fourth.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StepRail, type StepRailItem } from '../StepRail.js';

const ITEMS: StepRailItem[] = [
  { id: 'brief', label: 'Brief', to: '/c/1/brief', state: 'done', stateLabel: 'Done' },
  { id: 'plan', label: 'Plan', to: '/c/1/plan', state: 'needs-you', stateLabel: 'Needs you' },
  { id: 'create', label: 'Create', to: '/c/1/create', state: 'unknown', stateLabel: 'Unknown' },
];
const show = (currentId?: string): void => {
  render(<MemoryRouter><StepRail label="Campaign steps" items={ITEMS} {...(currentId ? { currentId } : {})} /></MemoryRouter>);
};
afterEach(cleanup);

describe('StepRail', () => {
  it('is a named nav with an ordered list, and no tablist', () => {
    show();
    const nav = screen.getByRole('navigation', { name: 'Campaign steps' });
    const list = within(nav).getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('links each step to its own address, in order', () => {
    show();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/c/1/brief', '/c/1/plan', '/c/1/create']);
  });

  it('marks only the current step, and none when there is no current step', () => {
    show('plan');
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    cleanup();
    show();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('aria-current'))).toEqual([null, null, null]);
  });

  it('says each step state in words inside the link', () => {
    show();
    expect(screen.getByRole('link', { name: /Brief.*Done/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Plan.*Needs you/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Create.*Unknown/ })).toBeTruthy();
  });
});
