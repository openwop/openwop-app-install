/**
 * ADR 1064 P3c — the flow as a rail (the features page's five stops).
 *
 * `numbers: 'circle'` (columns `flow`) or `flow.numbered` (hero) puts the step
 * number in each mark: decoration, since the list is already an ordered
 * list. `run` lights the marks in turn on a 7 s loop and carries the shared
 * pause control, which toggles `is-paused` and says what it will do. The loop
 * animates a ring only (never opacity) and is gated on reduced motion. Without
 * either option the flow renders as before.
 *
 * Red when: the numbers drop or leave the aria-hidden mark (columns or hero),
 * the run loop loses its pause control, starts paused, or the control stops
 * toggling (and back), the CSS stops pausing a paused rail, the animation
 * touches opacity in any keyframe stop, any use of it sits outside a
 * `(prefers-reduced-motion: no-preference)` media rule (any spelling of the
 * prelude counts, e.g. `screen and (…)`), or a plain flow changes.
 *
 * Sabotage-witnessed (w92, /grade-tests): unpadded numbers, the numbered or run
 * class dropped, the columns or hero wiring dropped, a rail paused from the
 * start or never paused, a label that never changes, no control, opacity in
 * the first or the last keyframe stop, the guard removed or flipped to
 * `reduce`, and the `.is-paused` CSS rule renamed each turn a case here red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const STEPS = [
  { title: 'Something kicks it off', text: 'A form, a schedule, or Start.' },
  { title: 'Agents split up the work', text: 'One looks people up.' },
  { title: 'It stops where you told it to', text: 'It waits for you.', state: 'waiting', status: 'Waits for you' },
  { title: 'Everything is on the record', text: 'What went in and out.' },
  { title: 'Redo just the part that went wrong', text: 'No starting over.' },
];
const renderSection = (section: Section): HTMLElement =>
  render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>).container;
const flow = (data: Record<string, unknown>): HTMLElement =>
  renderSection({ sectionId: 'sec:rail', type: 'columns', data: { layout: 'flow', columns: STEPS, ...data } });

/** The index of the `}` that closes the `{` at `open`. */
function closeOf(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }
  return -1;
}
/** The preludes of every block enclosing `at`, innermost first. */
function enclosingPreludes(css: string, at: number): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (css[i] === '}') depth++;
    else if (css[i] === '{') {
      if (depth > 0) { depth--; continue; }
      const start = Math.max(css.lastIndexOf('}', i - 1), css.lastIndexOf('{', i - 1), css.lastIndexOf(';', i - 1)) + 1;
      out.push(css.slice(start, i).trim());
    }
  }
  return out;
}
const isMotionGuard = (p: string): boolean => /^@media\b[^{]*\(prefers-reduced-motion:\s*no-preference\)/.test(p);
const blankComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

describe('flow rail', () => {
  it('numbers each mark, inside the decorative mark', () => {
    const c = flow({ numbers: 'circle' });
    expect(c.querySelector('.fp-flow')?.classList.contains('fp-flow--numbered')).toBe(true);
    const marks = [...c.querySelectorAll('.fp-flow__mark')];
    expect(marks.map((m) => m.textContent)).toEqual(['01', '02', '03', '04', '05']);
    expect(marks.every((m) => m.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(c.querySelector('ol.fp-flow__steps')).not.toBeNull();
  });

  it('a running rail carries the pause control, which toggles', () => {
    const c = flow({ numbers: 'circle', run: true });
    const rail = c.querySelector('.fp-flow--run') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(rail.classList.contains('is-paused')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pause the animation' }));
    expect(rail.classList.contains('is-paused')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Play the animation' }));
    expect(rail.classList.contains('is-paused')).toBe(false);
    expect(screen.getByRole('button', { name: 'Pause the animation' })).toBeTruthy();
  });

  it('the hero flow takes the same numbered, running rail', () => {
    const c = renderSection({ sectionId: 'sec:hero', type: 'hero', data: { heading: 'Features', visual: 'flow', flow: { numbered: true, run: true, nodes: STEPS.slice(0, 3).map((s) => ({ label: s.title })) } } });
    const rail = c.querySelector('.fp-flow__rail') as HTMLElement;
    expect(rail.classList.contains('fp-flow--numbered')).toBe(true);
    expect(rail.classList.contains('fp-flow--run')).toBe(true);
    expect([...rail.querySelectorAll('.fp-flow__mark')].map((m) => m.textContent)).toEqual(['01', '02', '03']);
    expect(screen.getByRole('button', { name: 'Pause the animation' })).toBeTruthy();
  });

  it('a plain flow is unchanged: no numbers, no loop, no control', () => {
    const c = flow({});
    expect(c.querySelector('.fp-flow--numbered, .fp-flow--run')).toBeNull();
    expect([...c.querySelectorAll('.fp-flow__mark')].every((m) => m.textContent === '')).toBe(true);
    expect(c.querySelector('button')).toBeNull();
  });

  it('animates a ring only, behind the reduced-motion gate', () => {
    const css = blankComments(readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8'));
    // The whole keyframe body, brace-matched (every stop).
    const at = css.indexOf('@keyframes fp-flow-lit');
    expect(at).toBeGreaterThan(-1);
    const open = css.indexOf('{', at);
    const kf = css.slice(open, closeOf(css, open) + 1);
    expect(kf).toContain('box-shadow');
    expect(kf).not.toContain('opacity');
    // Every use sits inside a no-preference media rule, however it is spelt.
    const uses = [...css.matchAll(/animation:\s*fp-flow-lit\b/g)].map((m) => m.index!);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(enclosingPreludes(css, use).some(isMotionGuard)).toBe(true);
    // The pause control's class actually pauses the marks.
    expect(css).toMatch(/\.fp-flow--run\.is-paused \.fp-flow__mark[^{]*\{[^}]*animation-play-state:\s*paused/);
  });
});
