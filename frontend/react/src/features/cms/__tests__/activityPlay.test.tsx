/**
 * ADR 1038 P1 — the hero activity card that plays once, as a visitor and an
 * editor meet it.
 * Guards:
 * - a played card carries the play hook and a per-row `--i`; the count is a real
 *   sentence with the real digit ("2 of 3 done": done + approved rows), so a
 *   screen reader or a copy never meets a mid-count number; a bar sits under it;
 * - a still card has no count and no bar, and its rows carry no `--i`;
 * - the result line is real text on both;
 * - the editor offers "Play once on load" on the base layer only (it is
 *   presentation, which an overlay never carries) and unticking removes the key;
 * - a translation without `{{done}}` still shows its sentence;
 * - the CSS (which jsdom cannot run) keeps the three properties a review found
 *   broken: the tally is visible while it counts, the overlay has empty alt text,
 *   the RTL bar rule sits on `:root` (where `dir` is), and `motion: none` opts out
 *   on EVERY `.fp-activity--play` line (10 at the time of writing), selector
 *   lines of a multi-selector rule included.
 *
 * Ceiling: the timing and the counting overlay are CSS; jsdom sees the markup
 * and hooks. Sabotage-witnessed (2026-11-03, re-measured w86 grade-tests):
 * dropping the digit from the count, counting every row as settled, dropping the
 * play class or the result line, indexing still rows, showing the tally on a
 * still card, losing the no-placeholder fallback, storing `still` on untick,
 * showing the checkbox on an overlay, a result input that writes nothing,
 * delaying the tally, giving the overlay spoken content, anchoring the RTL rule
 * off `:root`, and dropping the `motion: none` guard from any played line each
 * turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const activity = { title: 'Launch', result: 'Live at your-app.com', items: [
  { actor: 'Ana', action: 'set up billing', status: 'Done', state: 'done' },
  { actor: 'PM', action: 'approved the brand', status: 'Approved', state: 'approved' },
  { actor: 'Agent', action: 'is waiting on you', status: 'Waiting', state: 'waiting' },
] };
const sec = (data: Record<string, unknown>): Section => ({ sectionId: 's', type: 'hero', data });
const view = (data: Record<string, unknown>) =>
  render(<MemoryRouter><RenderSection section={sec(data)} mode="public" /></MemoryRouter>);

describe('a played activity card', () => {
  it('counts the settled rows in a real sentence, with a bar and the result line', () => {
    view({ heading: 'H', visual: 'activity', activity, play: 'once' });
    const fig = screen.getByRole('figure', { name: 'Launch' });
    expect(fig.className).toContain('fp-activity--play');
    expect(fig.textContent).toContain('2 of 3 done');
    expect(fig.querySelector('.fp-activity__n')?.textContent).toBe('2');
    expect(fig.querySelector('.fp-progress')?.getAttribute('aria-hidden')).toBe('true');
    const rows = fig.querySelectorAll('li');
    expect([...rows].map((r) => r.style.getPropertyValue('--i'))).toEqual(['0', '1', '2']);
    expect(screen.getByText('Live at your-app.com')).toBeTruthy();
  });

  it('a still card has no count, no bar and no row index, but keeps the result', () => {
    view({ heading: 'H', visual: 'activity', activity });
    const fig = screen.getByRole('figure', { name: 'Launch' });
    expect(fig.className).not.toContain('fp-activity--play');
    expect(fig.textContent).not.toMatch(/of 3 done/);
    expect(fig.querySelector('.fp-progress')).toBeNull();
    expect([...fig.querySelectorAll('li')].map((r) => r.style.getPropertyValue('--i'))).toEqual(['', '', '']);
    expect(screen.getByText('Live at your-app.com')).toBeTruthy();
  });
});

describe('the editor', () => {
  it('offers play-once on the base layer and removes the key when unticked', () => {
    const onChange = vi.fn<(d: Record<string, unknown>) => void>();
    const { rerender } = render(<SectionFields section={sec({ heading: 'H', visual: 'activity', activity })} assets={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Play once on load' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ play: 'once' }));
    rerender(<SectionFields section={sec({ heading: 'H', visual: 'activity', activity, play: 'once' })} assets={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Play once on load' }));
    expect(onChange.mock.lastCall?.[0]).toBeDefined();
    expect('play' in (onChange.mock.lastCall?.[0] ?? { play: 'missing call' })).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Result line' }), { target: { value: 'Shipped' } });
    expect(onChange.mock.lastCall?.[0].activity).toEqual({ ...activity, result: 'Shipped' });
  });

  it('hides play-once on a locale overlay', () => {
    render(<SectionFields section={sec({ heading: 'Hola', visual: 'activity', activity })} baseData={{ heading: 'H' }} assets={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: 'Play once on load' })).toBeNull();
  });
});

describe('the played card CSS', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
  const rule = (sel: string): string => {
    const at = css.indexOf(sel);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };

  it('shows the tally from the moment the count and the bar start', () => {
    const delay = (body: string): string => /animation-delay: ([^;]+);/.exec(body)?.[1] ?? '';
    const tally = rule('.fp-activity--play .fp-activity__tally {');
    const count = rule('.fp-activity--play .fp-activity__n::after {');
    expect(delay(tally)).toBe('700ms');
    expect(delay(count)).toBe('700ms');
    expect(delay(rule('.fp-activity--play .fp-progress__fill {'))).toBe('700ms');
  });

  it('keeps the counting overlay out of the accessibility tree', () => {
    expect(rule('.fp-activity--play .fp-activity__n::after {')).toContain('content: counter(fp-n) / "";');
  });

  it('hides the real digit only where the overlay can draw (ACT-1)', () => {
    // Inside the forced-colours block, under an alt-text `content` support
    // query: without it, an engine that rejects `/ ""` would keep the digit
    // transparent and drop the overlay, and the count would vanish.
    const at = css.indexOf('.fp-activity--play .fp-activity__n { position: relative; color: transparent; }');
    expect(at).toBeGreaterThan(-1);
    expect(css.lastIndexOf('@supports (content: "" / "")', at)).toBeGreaterThan(css.lastIndexOf('@media (forced-colors: none)', at));
  });

  it('anchors the RTL bar on :root and lets motion none opt out', () => {
    expect(css).toContain(':root[dir="rtl"]:not([data-reduce-motion="reduce"]) .fp-hero:not(.fp-motion--none) .fp-activity--play .fp-progress__fill');
    const played = css.split('\n').filter((l) => l.includes('.fp-activity--play'));
    expect(played.filter((l) => l.includes('animation:')).length).toBeGreaterThan(0);
    for (const l of played) expect(l).toContain('.fp-hero:not(.fp-motion--none)');
  });
});

describe('a translation without the count placeholder', () => {
  it('still shows the sentence', async () => {
    const i18n = (await import('i18next')).default;
    const prev = i18n.getResource('en', 'cms', 'activityCount') as string;
    i18n.addResource('en', 'cms', 'activityCount', 'All {{total}} steps');
    try {
      view({ heading: 'H', visual: 'activity', activity, play: 'once' });
      expect(screen.getByRole('figure', { name: 'Launch' }).textContent).toContain('All 3 steps');
    } finally {
      i18n.addResource('en', 'cms', 'activityCount', prev);
    }
  });
});
