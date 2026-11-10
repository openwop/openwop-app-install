/**
 * ADR 1068 D1 — film details from the myndhyve.ai design (HOME-07, CAP-05,
 * HOME-27, HOME-23).
 *
 *  1. `chipLabel` is what the corner chip SHOWS; the button's accessible name
 *     still names the film (`title`) and the length, and the label is not read
 *     twice. Absent, the chip shows the title as before. The second film too.
 *  2. `caption` is a visible mono line under the film, also with the corner chip.
 *  3. The chip is one line (the design's pill): row text, a 38px disc with a
 *     ring, the dark translucent pill from the inverse tokens, disc colours as
 *     brand tokens.
 *  4. A card strip at rest is one sideways-scrolling row whose viewport is a
 *     named, focusable region; a name-only marquee keeps wrapping and gets no
 *     region; the moving strip hides its overflow inside the motion guard.
 *
 * Sabotage (each witnessed red): show `title` instead of `chipLabel`; drop the
 * sr-only title (the name stops naming the film); leave the label not
 * aria-hidden (read twice); drop the caption, or hide it under the chip; the
 * chip text back to a column; drop the region attributes, name the region with
 * anything but its catalog label, or put them on a name-only marquee; drop the
 * rest-state nowrap; move the moving-strip overflow rule out of the motion guard
 * (any `@media … (prefers-reduced-motion: no-preference)` prelude counts).
 */
import { readFileSync } from 'node:fs';
import postcss, { type AtRule, type Rule } from 'postcss';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { Marquee } from '../sectionStyles.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
const cssRoot = postcss.parse(css);
function rule(sel: string): string {
  const i = css.indexOf(`${sel} {`);
  if (i < 0) throw new Error(`no rule ${sel}`);
  return css.slice(i, css.indexOf('}', i) + 1);
}
/** Every @media block enclosing the rule that starts at `at`, outermost first,
 *  from a real CSS parse (postcss, a dev dependency through Vite). Counting braces
 *  by hand broke on braces inside strings and comments in global.css and
 *  reported dozens of "open" blocks, which made a `toContain` check vacuous. */
function openMediaAt(at: number): string {
  let hit: Rule | null = null;
  cssRoot.walkRules((r) => {
    const s = r.source?.start?.offset; const e = r.source?.end?.offset;
    if (s !== undefined && e !== undefined && s <= at && at <= e) hit = r;
  });
  const chain: string[] = [];
  for (let p = (hit as Rule | null)?.parent; p && p.type !== 'root'; p = p.parent) {
    if (p.type === 'atrule' && (p as AtRule).name === 'media') chain.unshift(`@media ${(p as AtRule).params}`);
  }
  return chain.join(' > ');
}

/** An OS reduced-motion media block, however its prelude is spelled (`screen and` or not). */
const isMotionGuard = (p: string): boolean => /^@media\b[^{]*\(prefers-reduced-motion:\s*no-preference\)/.test(p);

const FILM = { title: 'Everywhere your work happens', length: '3:30', src: 'https://example.test/f.mp4', poster: 'https://example.test/f.jpg' };
const renderVideo = (data: Record<string, unknown>) => {
  const section: Section = { sectionId: 'v', type: 'video', data };
  return render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
};

describe('1. chipLabel', () => {
  it('shows the label, keeps the film in the accessible name, and reads nothing twice', () => {
    renderVideo({ ...FILM, chip: 'corner', chipLabel: 'Watch the tour' });
    const button = screen.getByRole('button', { name: 'Watch the video: Everywhere your work happens 3:30' });
    const shown = button.querySelector('.fp-film__chip-title');
    expect(shown?.textContent).toBe('Watch the tour');
    expect(shown?.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the title, and applies to the second film', () => {
    renderVideo({ ...FILM, chip: 'corner', film2: { ...FILM, title: 'Tuesday, 2:14 am', length: '1:40', chipLabel: 'Watch Tuesday' } });
    const first = screen.getByRole('button', { name: 'Watch the video: Everywhere your work happens 3:30' });
    expect(first.querySelector('.fp-film__chip-title')?.textContent).toBe('Everywhere your work happens');
    expect(first.querySelector('.fp-film__chip-title')?.getAttribute('aria-hidden')).toBeNull();
    const second = screen.getByRole('button', { name: 'Watch the video: Tuesday, 2:14 am 1:40' });
    expect(second.querySelector('.fp-film__chip-title')?.textContent).toBe('Watch Tuesday');
  });
});

describe('2. caption', () => {
  it('is a visible line under the film, also with the corner chip', () => {
    const { container } = renderVideo({ ...FILM, chip: 'corner', caption: 'Agents, then workflows, then your own app.' });
    const cap = container.querySelector('figcaption .fp-film__caption');
    expect(cap?.textContent).toBe('Agents, then workflows, then your own app.');
    // The chip still keeps the title out of the caption.
    expect(container.querySelector('figcaption .fp-film__title')).toBeNull();
    cleanup();
    const plain = renderVideo({ ...FILM, caption: 'A line.' });
    const parts = Array.from(plain.container.querySelector('figcaption')!.children).map((n) => n.className);
    expect(parts).toEqual(['fp-film__title', 'fp-film__caption']);
  });

  it('is set in mono', () => {
    expect(rule('.fp-film__caption')).toContain('font-family: var(--mono);');
  });
});

describe('3. the chip is one line', () => {
  it('row text, a 38px ringed disc, the inverse pill, brand-token disc colours', () => {
    expect(rule('.fp-film__chip-text')).toContain('flex-direction: row;');
    const disc = rule('.fp-film__disc');
    expect(disc).toContain('inline-size: 38px;');
    expect(disc).toContain('background: var(--fp-film-disc, var(--clay));');
    expect(disc).toMatch(/box-shadow: 0 0 0 3px/);
    const play = rule('.fp-film--corner .fp-film__play');
    expect(play).toContain('background: color-mix(in srgb, var(--tone-inverse-bg) 82%, transparent);');
    expect(play).toContain('min-block-size: 52px;');
  });
});

describe('4. the card strip at rest', () => {
  it('names and focuses the scrolling viewport for cards, not for names', () => {
    const { container } = render(<Marquee items={[]} cards={[<span key="a">A</span>, <span key="b">B</span>]} />);
    const vp = container.querySelector('.fp-marquee__viewport')!;
    expect(vp.getAttribute('role')).toBe('region');
    expect(vp.getAttribute('tabindex')).toBe('0');
    // The en catalog's label, as rendered through t() (a raw key or a blank fails).
    expect(vp.getAttribute('aria-label')).toBe('Cards, scroll sideways');
    cleanup();
    const names = render(<Marquee items={['KickTodo', 'BookAI']} />);
    const nvp = names.container.querySelector('.fp-marquee__viewport')!;
    expect(nvp.getAttribute('role')).toBeNull();
    expect(nvp.getAttribute('tabindex')).toBeNull();
  });

  it('stays one row at rest, and hides overflow only while moving', () => {
    expect(rule('.fp-marquee__list:has(> .fp-marquee__item--card)')).toContain('flex-wrap: nowrap;');
    expect(rule('.fp-marquee__viewport:has(.fp-marquee__item--card)')).toContain('overflow-x: auto;');
    const moving = '.fp-marquee-section:not(.fp-motion--none) .fp-marquee__viewport { overflow: hidden;';
    const at = css.indexOf(moving);
    expect(at).toBeGreaterThan(0);
    expect(css.lastIndexOf(moving), 'one moving-strip overflow rule').toBe(at);
    expect(isMotionGuard(openMediaAt(at)), openMediaAt(at)).toBe(true);
  });
});
