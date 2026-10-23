/**
 * The hero journey motif (visual: 'journey') — the animated week.
 *
 * Markup claims (jsdom): the five days read done / done / missed / done / done,
 * a done day carries its check, the missed day does not, the detour and the goal
 * flag are drawn, the trail is normalised (`pathLength=1`, what the draw-in's
 * dash offset is measured against), the whole motif is hidden from assistive
 * technology, and it follows the copy in the DOM (the phone variant sits under
 * the copy by flow).
 *
 * Motion claims (the stylesheet, since jsdom runs no CSS): every journey
 * `animation` lives inside the one block gated on BOTH `prefers-reduced-motion:
 * no-preference` and the absence of the user's `data-reduce-motion` override, so
 * a reduced-motion visitor gets the base rules — the finished picture. The goal
 * pulses exactly once, and nothing loops.
 *
 * Shipped by b20215cf7 in #4993 (the motif follows the copy; the gated motion
 * block). Graded in /grade-tests wave 57, tracker row TST-FT4-1.
 *
 * Sabotage (witnessed, /grade-tests w57): marking the missed day done
 * (`hj-missed-done`), a check on the missed day (`hj-check-on-missed`), no flag,
 * no detour, `pathLength` other than 1, un-hiding the svg (`hj-aria-hidden`;
 * SectionRenderer.heroVisual.test.tsx:35-38 makes the same assertion as a
 * twin, which the probe did not run), the
 * artwork before the copy (`hj-art-before-copy`), the draw-in outside the gate,
 * the OS gate replaced by `@media all`, a rule without the user override, the
 * pulse set to `infinite`, and (r2) the @media closed early so the rules sit
 * ungated between the markers (`hj-media-closed-early`) and an animation on the
 * svg root `.fp-hero__journey` outside the gate (`hj-root-anim-outside`) each
 * turn a case red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function view() {
  const section: Section = { sectionId: 'hero', type: 'hero', data: { heading: 'Make progress', visual: 'journey' } };
  return render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
}

describe('hero journey markup', () => {
  it('draws the week: done, done, missed, done, done, then the goal with its flag', () => {
    const { container } = view();
    const svg = container.querySelector('.fp-hero__journey')!;
    // Twin of SectionRenderer.heroVisual.test.tsx:35 (kept: protected a11y claim).
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const days = [...svg.querySelectorAll('.fp-journey__node:not(.fp-journey__node--goal)')];
    const kinds = days.map((g) => (g.classList.contains('fp-journey__node--done') ? 'done' : g.classList.contains('fp-journey__node--missed') ? 'missed' : '?'));
    expect(kinds).toEqual(['done', 'done', 'missed', 'done', 'done']);
    expect(days.map((g) => g.querySelector('.fp-journey__check') !== null)).toEqual([true, true, false, true, true]);
    expect(svg.querySelector('.fp-journey__node--goal .fp-journey__flag')).toBeTruthy();
    expect(svg.querySelector('.fp-journey__detour')).toBeTruthy();
    expect(svg.querySelector('.fp-journey__path')?.getAttribute('pathLength')).toBe('1');
  });

  it('follows the copy, so the phone variant sits under the heading', () => {
    const { container } = view();
    const heading = screen.getByRole('heading', { level: 1, name: 'Make progress' });
    const svg = container.querySelector('.fp-hero__journey')!;
    expect(heading.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('hero journey motion (stylesheet)', () => {
  const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8');
  const start = css.indexOf('/* fp-journey-motion:start */');
  const end = css.indexOf('/* fp-journey-motion:end */');
  const gated = css.slice(start, end);
  const rest = css.slice(0, start) + css.slice(end);

  it('animates only inside the block gated on BOTH reduced-motion signals', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // ONE @media block, opened right after the start marker and closed right
    // before the end marker, holding ONLY single-line journey rules that also
    // carry the user override. A string match alone passed an @media closed early
    // (`{}`), which leaves every rule ungated.
    expect(gated.trimEnd()).toMatch(
      /^\/\* fp-journey-motion:start \*\/\n@media \(prefers-reduced-motion: no-preference\) \{\n( {2}:root:not\(\[data-reduce-motion="reduce"\]\) \.fp-journey__[^\n{}]*\{[^\n{}]*\}\n)+\}$/,
    );
    const rules = gated.split('\n').filter((l) => l.includes('.fp-journey__'));
    expect(rules.length).toBe(11);
    // Outside the gate: no journey rule animates (the svg root and the phone
    // variant included), and the trail is not dashed out (a reduced-motion
    // visitor would see an undrawn path).
    const outside = rest.split('\n').filter((l) => /fp-journey__|fp-hero__journey|fp-hero--journey/.test(l));
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.filter((l) => /animation|stroke-dashoffset/.test(l))).toEqual([]);
  });

  it('pulses the goal once and loops nothing', () => {
    expect(gated).not.toMatch(/infinite/);
    expect(gated).toMatch(/fp-journey-pulse [^;]* 1;/);
  });
});
