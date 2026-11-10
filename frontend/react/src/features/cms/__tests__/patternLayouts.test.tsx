/**
 * ADR 1029 D5 — the pattern layouts as a visitor and an editor meet them.
 * Guards:
 * - the activity card is a figure named by its title (or "Activity"), each row
 *   real text with the author's status word; `state` only adds a style hook;
 * - the timeline is an ordered list; a bento tile is wide only when `wide`;
 * - the marquee shows ONE readable list; the visual copy is aria-hidden and
 *   inert; the pause button's label says what it will do, and it pauses and
 *   resumes the strip;
 * - the editor offers the three layouts, the activity rows (add, edit, a closed
 *   style select) and, for bento, a "wide" checkbox.
 *
 * Ceiling: the drift and the rise are CSS (verified separately in headless
 * Chromium); jsdom sees the markup and the hooks. Sabotage-witnessed: dropping
 * aria-hidden from the copy, a label that never changes, or rendering `state` as
 * the visible word each turn a case red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}

describe('the activity card', () => {
  const activity = { title: 'Launch review', items: [
    { actor: 'Ana', action: 'flagged the 38% claim', status: 'Flagged', state: 'flagged', meta: '2 min ago' },
    { actor: 'Client PM', action: 'approved the launch', status: 'Approved', state: 'approved' },
    { action: 'spec synced' },
  ] };

  it('is a figure named by its title, with every row as text in order', () => {
    view('hero', { heading: 'H', visual: 'activity', activity });
    const fig = screen.getByRole('figure', { name: 'Launch review' });
    const rows = within(fig).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      'Ana flagged the 38% claim2 min agoFlagged',
      'Client PM approved the launchApproved',
      'spec synced',
    ]);
    expect(rows[0]!.className).toContain('fp-activity__row--flagged');
    expect(rows[2]!.className).toBe('fp-activity__row');
  });

  it('is named "Activity" without a title, and renders nothing with no rows', () => {
    view('hero', { heading: 'H', visual: 'activity', activity: { items: [{ action: 'ran' }] } });
    expect(screen.getByRole('figure', { name: 'Activity' })).toBeTruthy();
    cleanup();
    const { container } = view('hero', { heading: 'H', visual: 'activity', activity: { items: [{ actor: 'only' }] } });
    expect(container.querySelector('.fp-activity')).toBeNull();
  });
});

describe('timeline and bento', () => {
  const cols = [{ title: 'Kickoff', text: 'We meet.', eyebrow: 'Week 1' }, { title: 'Launch', text: 'It ships.', wide: true }];

  it('a timeline is an ordered list with its dates', () => {
    const { container } = view('columns', { heading: 'Plan', layout: 'timeline', columns: cols });
    const list = container.querySelector('ol.fp-timeline__list')!;
    expect(within(list as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(list.textContent).toContain('Week 1');
  });

  it('a bento tile is wide only when `wide` is set', () => {
    const { container } = view('columns', { heading: 'Why', layout: 'bento', columns: cols });
    const tiles = container.querySelectorAll('.fp-bento__tile');
    expect(tiles[0]!.className).not.toContain('--wide');
    expect(tiles[1]!.className).toContain('fp-bento__tile--wide');
  });
});

describe('the marquee', () => {
  const data = { heading: 'Works with', layout: 'marquee', columns: [{ title: 'Slack', text: '' }, { title: 'Figma', text: '' }, { title: '', text: 'Linear' }] };

  it('shows one readable list; the visual copy is hidden from assistive tech and focus', () => {
    const { container } = view('columns', data);
    const lists = container.querySelectorAll('.fp-marquee__list');
    expect(lists).toHaveLength(2);
    expect(lists[0]!.getAttribute('aria-hidden')).toBeNull();
    expect(lists[1]!.getAttribute('aria-hidden')).toBe('true');
    expect(lists[1]!.hasAttribute('inert')).toBe(true);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Slack', 'Figma', 'Linear']);
  });

  it('a pause button says what it will do, and pauses and resumes the strip', () => {
    const { container } = view('columns', data);
    const strip = container.querySelector('.fp-marquee')!;
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(strip.className).toContain('is-paused');
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play.hasAttribute('aria-pressed')).toBe(false);
    fireEvent.click(play);
    expect(strip.className).not.toContain('is-paused');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });
});

describe('the editor', () => {
  const sec = (type: Section['type'], data: Record<string, unknown>): Section => ({ sectionId: 's', type, data });

  it('offers the three layouts, and a wide checkbox for bento', () => {
    const onChange = vi.fn();
    render(<SectionFields section={sec('columns', { layout: 'bento', columns: [{ title: 'A', text: 'B' }] })} assets={[]} onChange={onChange} />);
    const layout = screen.getByLabelText('Layout') as HTMLSelectElement;
    expect([...layout.options].map((o) => o.value)).toEqual(expect.arrayContaining(['timeline', 'bento', 'marquee']));
    fireEvent.click(screen.getByLabelText('Wide tile (two columns)'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ columns: [{ title: 'A', text: 'B', wide: true }] }));
  });

  it('says what a marquee shows, and offers no link or icon for it', () => {
    render(<SectionFields section={sec('columns', { layout: 'marquee', columns: [{ title: 'Slack', text: '' }] })} assets={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/shows each item's title/)).toBeTruthy();
    expect(screen.queryByText('Destination (optional)')).toBeNull();
    cleanup();
    render(<SectionFields section={sec('columns', { layout: 'cards', columns: [{ title: 'A', text: 'B' }] })} assets={[]} onChange={vi.fn()} />);
    expect(screen.queryByText(/shows each item's title/)).toBeNull();
    expect(screen.getByText('Destination (optional)')).toBeTruthy();
  });

  it('edits activity rows: add, fill, and a closed style', () => {
    const onChange = vi.fn();
    render(<SectionFields section={sec('hero', { heading: 'H', visual: 'activity', activity: { items: [{ actor: 'Ana', action: 'flagged' }] } })} assets={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Row 1: status'), { target: { value: 'Flagged' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ activity: { items: [{ actor: 'Ana', action: 'flagged', status: 'Flagged' }] } }));
    const style = screen.getByLabelText('Row style') as HTMLSelectElement;
    expect([...style.options].map((o) => o.value)).toEqual(['', 'done', 'waiting', 'approved', 'flagged']);
    fireEvent.click(screen.getByRole('button', { name: /Add row/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ activity: { items: [{ actor: 'Ana', action: 'flagged' }, { actor: '', action: '' }] } }));
  });
});
