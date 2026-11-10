/**
 * ADR 1063 P2c/P2d — the bento tile's `count` and `tone: "inverse"`.
 *
 * The count rides the ONE count-up in the app, ADR 1038 D3's `StatValue`: the
 * real number stays in the DOM as text (so the prerender, reduced motion,
 * forced colours and any browser without scroll timelines show it), and CSS
 * counts it up on the tile's own view timeline. P2c first shipped a second, JS
 * count-up for this; P2d removed it (ADR 1063 D5 correction note). The stats
 * band's own count-up is unchanged: the bento rules were ADDED as separate
 * rules after the stats ones in the same block. A dark tile carries the
 * inverse band class.
 *
 * What the CSS case enforces: each stats and bento count-up rule occurs once
 * and the at-rules open around it (brace walk, comments blanked) are exactly
 * `@supports (animation-timeline: view())`, an OS reduced-motion media (any
 * prelude carrying `(prefers-reduced-motion: no-preference)`, with or without
 * `screen and`) and `@media (forced-colors: none)`, the SAME block for stats
 * and bento; the stats `::after` body is byte-identical to its declarations,
 * and the bento `::after` body equals it (one mechanism). statCount.test.tsx
 * owns the guard depth of the digit-hiding lines (stats and bento).
 *
 * Red when (sabotage-witnessed, w91 g2): the tile stops rendering through
 * StatValue or loses `--to`, the inverse class drops, the tile's timeline is
 * renamed, the bento rules leave forced-colours, the reduced-motion guard is
 * flipped to `reduce` or removed, `@supports` changes, the stats `::after`
 * name or range changes, the bento `::after` drifts, or a second
 * `@keyframes fp-count` appears.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const bento: Section = {
  sectionId: 'sec:loop', type: 'columns',
  data: {
    layout: 'bento',
    columns: [
      { title: 'Nodes', text: 'Ready-made steps.', count: 130 },
      { title: 'Four stages', text: 'From idea to app.', tone: 'inverse' },
    ],
  },
};
const renderBento = (): HTMLElement => render(<MemoryRouter><RenderSection section={bento} mode="public" /></MemoryRouter>).container;

describe('bento count through StatValue', () => {
  it('renders the real number as text, marked for the CSS count-up', () => {
    const c = renderBento();
    const count = c.querySelector('.fp-bento__count .fp-count');
    if (!(count instanceof HTMLElement)) throw new Error('missing .fp-bento__count .fp-count');
    expect(count.textContent).toBe('130');
    expect(count.style.getPropertyValue('--to')).toBe('130');
    // No second, JS-driven copy of the number.
    expect(c.querySelector('.fp-bento__count')?.textContent).toBe('130');
    expect(c.querySelectorAll('.fp-bento__count [aria-hidden]')).toHaveLength(0);
  });

  it('marks the dark tile with the inverse band', () => {
    const tiles = [...renderBento().querySelectorAll('.fp-bento__tile')];
    expect(tiles).toHaveLength(2);
    expect(tiles[1]?.classList.contains('fp-bento__tile--inverse')).toBe(true);
    expect(tiles[1]?.classList.contains('fp-tone--inverse')).toBe(true);
    expect(tiles[0]?.classList.contains('fp-bento__tile--inverse')).toBe(false);
    expect(tiles[0]?.classList.contains('fp-tone--inverse')).toBe(false);
  });
});

/** An OS reduced-motion media block, however its prelude is spelled (`screen and` or not). */
const isMotionGuard = (p: string): boolean => /^@media\b[^{]*\(prefers-reduced-motion:\s*no-preference\)/.test(p);
const SUPPORTS = '@supports (animation-timeline: view())';
const FORCED = '@media (forced-colors: none)';
/** The block preludes still open at `index` (comments blanked to keep offsets). */
function openAt(text: string, index: number): string[] {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < index; i++) {
    if (s[i] === '{') { stack.push(s.slice(start, i).trim()); start = i + 1; }
    else if (s[i] === '}') { stack.pop(); start = i + 1; }
    else if (s[i] === ';') start = i + 1;
  }
  return stack;
}
/** Offset of the one occurrence of `sel` (a second one is a failure). */
function once(css: string, sel: string): number {
  const at = css.indexOf(sel);
  expect(at, sel).toBeGreaterThan(-1);
  expect(css.indexOf(sel, at + 1), `${sel} occurs twice`).toBe(-1);
  return at;
}
/** The declarations of the `::after` rule that starts with `sel`. */
function afterBody(css: string, sel: string): string[] {
  const at = once(css, sel) + sel.length;
  return css.slice(at, css.indexOf('}', at)).split(';').map((d) => d.trim()).filter(Boolean);
}

describe('one count-up block, stats unchanged', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');

  it('puts the bento count beside the stats count in the same guarded block', () => {
    const STATS_AFTER = '.fp-stats:not(.fp-motion--none) .fp-count::after {';
    const BENTO_AFTER = '.fp-bento:not(.fp-motion--none) .fp-bento__count .fp-count::after {';
    const sels = [
      '.fp-stats:not(.fp-motion--none) .fp-stat { view-timeline: --fp-stat block; }',
      STATS_AFTER,
      '.fp-bento:not(.fp-motion--none) .fp-bento__tile:has(.fp-bento__count) { view-timeline: --fp-stat block; }',
      '.fp-bento:not(.fp-motion--none) .fp-bento__count .fp-count { position: relative;',
      BENTO_AFTER,
    ];
    const blocks = sels.map((sel) => {
      const at = once(css, sel);
      const guards = openAt(css, at).filter((p) => p.startsWith('@'));
      expect(guards, sel).toHaveLength(3);
      expect(guards[0], sel).toBe(SUPPORTS);
      expect(isMotionGuard(guards[1] ?? ''), `${sel} under ${guards[1]}`).toBe(true);
      expect(guards[2], sel).toBe(FORCED);
      // The forced-colours block this rule sits in (the same one for all five).
      return css.lastIndexOf(`${FORCED} {`, at);
    });
    expect(new Set(blocks).size).toBe(1);
    // The stats count's mechanism is byte-identical, and the bento count is the same mechanism.
    const stats = afterBody(css, STATS_AFTER);
    expect(stats).toEqual([
      'content: counter(fp-n) / ""',
      'counter-reset: fp-n var(--fp-n)',
      'position: absolute',
      'inset-inline-start: 0',
      '-webkit-text-fill-color: currentColor',
      'animation-name: fp-count',
      'animation-duration: auto',
      'animation-timing-function: linear',
      'animation-fill-mode: both',
      'animation-timeline: --fp-stat',
      'animation-range: entry 0% entry 100%',
    ]);
    expect(afterBody(css, BENTO_AFTER)).toEqual(stats);
  });

  it('has no second count-up keyframes or script hook', () => {
    expect(css.match(/@keyframes fp-count\b/g)).toHaveLength(1);
    const src = readFileSync(join(__dirname, '..', 'SectionRenderer.tsx'), 'utf8');
    expect(src).not.toMatch(/function CountUp\b/);
    expect(src).not.toContain('IntersectionObserver');
  });
});
