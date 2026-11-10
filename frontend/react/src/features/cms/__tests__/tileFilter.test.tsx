/**
 * ADR 1064 P3b — `tiles` with `filter: true`.
 *
 * The chips are "All (n)" plus each distinct badge, in order, as toggle
 * buttons (aria-pressed) in a named group. Picking one hides the other tiles
 * with `hidden`: they stay in the DOM, so the prerender and crawlers see every
 * tile. A polite status says how many show. Each badge is coloured by its
 * tile's status flags, so a "works" pill can never sit on a column flagged
 * future. Without `filter`, tiles render as before.
 *
 * Red when: a chip is missing or out of order, the pressed state is wrong,
 * filtered tiles leave the DOM or stay visible, the status line is wrong, a
 * badge takes another tile's status, or the plain tiles grow chips.
 * Sabotage-witnessed (w92, /grade-tests): no `hidden`, filtered tiles removed,
 * a fixed count, the wrong pressed chip, reversed badges, "All (3)", an
 * unnamed group, every badge coloured by the first tile, the filter on without
 * the flag, and an "All" click that keeps the pick each turn a case here red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const COLS = [
  { title: 'Marketing', badge: 'Works today', text: 'Campaign plans.' },
  { title: 'Sales follow-up', badge: 'Set up with you', partial: true, text: 'A first note.' },
  { title: 'Support', badge: 'Set up with you', partial: true, text: 'Sort incoming email.' },
  { title: 'Finance', badge: 'Not yet', future: true, text: 'Invoices.' },
];
const renderTiles = (data: Record<string, unknown>): HTMLElement => {
  const section: Section = { sectionId: 'sec:wf', type: 'columns', data: { heading: 'What your app can start with', layout: 'tiles', columns: COLS, ...data } };
  return render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>).container;
};

describe('tiles filter', () => {
  it('offers All plus each distinct badge, in order, and filters with hidden', () => {
    const c = renderTiles({ filter: true });
    const group = screen.getByRole('group', { name: 'Filter by status' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((b) => b.textContent)).toEqual(['All (4)', 'Works today', 'Set up with you', 'Not yet']);
    expect(chips.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    expect(screen.getByRole('status').textContent).toBe('Showing 4 of 4');

    fireEvent.click(chips[2]!);
    const tiles = [...c.querySelectorAll('.fp-cols__grid > li')] as HTMLElement[];
    expect(tiles).toHaveLength(4); // still in the DOM
    expect(tiles.map((t) => t.hidden)).toEqual([true, false, false, true]);
    expect(chips[2]!.getAttribute('aria-pressed')).toBe('true');
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('status').textContent).toBe('Showing 2 of 4');

    fireEvent.click(chips[0]!);
    expect(tiles.every((t) => !t.hidden)).toBe(true);
    expect(chips.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    expect(screen.getByRole('status').textContent).toBe('Showing 4 of 4');
  });

  it('colours each badge by its own tile status', () => {
    const c = renderTiles({ filter: true });
    expect([...c.querySelectorAll('.fp-col__badge')].map((b) => b.className.split(' ')[1]))
      .toEqual(['fp-col__badge--works', 'fp-col__badge--partial', 'fp-col__badge--partial', 'fp-col__badge--future']);
  });

  it('without filter, tiles render as before', () => {
    const c = renderTiles({});
    expect(c.querySelector('.fp-filter')).toBeNull();
    expect(c.querySelector('[role="status"]')).toBeNull();
    expect(c.querySelector('.fp-col__badge--works')).toBeNull();
  });
});
