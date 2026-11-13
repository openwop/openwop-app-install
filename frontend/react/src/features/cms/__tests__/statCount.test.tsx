/**
 * ADR 1038 P3 — a stats band whose figures count up as they arrive.
 * Guards:
 * - only one whole number (≤ 9 digits, no leading zero) with a short digit-free
 *   prefix (≤ 3 characters, which may end in one space) and suffix (≤ 5) counts;
 *   separators, decimals, ranges, words and `007` stay still, so a localized
 *   figure is never reformatted and the counter always ends on the number as
 *   written. Both length caps are pinned from each side (`US$ 4` / `USD$ 4`,
 *   `10 mil+` / `4 weeks`);
 * - a counting band renders the real digits in a `.fp-count` span with `--to`;
 *   a figure that cannot count, or a band without `count`, renders the plain title;
 * - the editor offers the checkbox only on a stats layout and only on the base
 *   layer, and unticking removes the key;
 * - the overlay is off in forced colours (the repainted digit would show through,
 *   "87" over "130" reading as "870"), the figure is never bidi-isolated, and only
 *   its paint is hidden so the overlay keeps the figure's colour;
 * - the CSS (which jsdom cannot run) keeps the digit transparent and the overlay
 *   inside `@supports (animation-timeline: view())` + both reduced-motion guards,
 *   binds each figure to its own named timeline, and gives the overlay empty alt text.
 *   Containment is checked by brace depth (comments stripped): every wrapping
 *   block must still be OPEN at the rule, so a block closed at its own indent or
 *   inline (`{}`) is caught, not only one closed at column 0;
 * - the hero activity counter (ADR 1038 P1) is off in forced colours too, by the
 *   same depth check.
 *
 * Ceiling: the counting is CSS; jsdom sees the markup. Sabotage-witnessed
 * (w87 probes): accepting `007`, a 10th digit, two prefix spaces, a digit in the
 * suffix, a 4-char suffix cap, no trim; `count: 'true'` rendering; no `--to`, no
 * prefix; the editor's layout and base-layer gates and the untick; the digit rule
 * out of `forced-colors: none` (renamed or closed early), its paint-only hiding,
 * its in-app guard; the overlay's alt text, timeline, a bidi isolate; and the
 * activity counter out of forced colours each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import { countableStat } from '../statNumber.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

/** Open-minus-closed braces in a CSS slice, comments stripped: how many blocks are still open at its end. */
const depth = (s: string): number => {
  const t = s.replace(/\/\*[\s\S]*?\*\//g, '');
  return (t.match(/\{/g)?.length ?? 0) - (t.match(/\}/g)?.length ?? 0);
};
const asElement = (el: Element | null | undefined): HTMLElement => {
  expect(el).toBeInstanceOf(HTMLElement);
  if (!(el instanceof HTMLElement)) throw new Error('expected an HTMLElement');
  return el;
};

describe('countableStat', () => {
  it.each([
    ['130', { prefix: '', value: 130, suffix: '' }],
    ['$4', { prefix: '$', value: 4, suffix: '' }],
    ['98%', { prefix: '', value: 98, suffix: '%' }],
    ['10k+', { prefix: '', value: 10, suffix: 'k+' }],
    [' 7× ', { prefix: '', value: 7, suffix: '×' }],
    ['0', { prefix: '', value: 0, suffix: '' }],
    ['R$ 4', { prefix: 'R$ ', value: 4, suffix: '' }],
    ['98 %', { prefix: '', value: 98, suffix: ' %' }],
    ['10 mil+', { prefix: '', value: 10, suffix: ' mil+' }],
    ['US$ 4', { prefix: 'US$ ', value: 4, suffix: '' }],
  ])('%s counts', (title, want) => { expect(countableStat(title)).toEqual(want); });

  it.each(['2,400', '3.5', '1-2', 'Ten', '24/7', '', '1234567890', 'about 40', '$  4', '007', 'USD$ 4', '4 weeks'])('%s stays still', (title) => {
    expect(countableStat(title)).toBeNull();
  });
});

const columns = [{ title: '130', text: 'teams' }, { title: '$4', text: 'per seat' }, { title: '24/7', text: 'support' }];
const sec = (data: Record<string, unknown>): Section => ({ sectionId: 's', type: 'columns', data });
const view = (data: Record<string, unknown>) =>
  render(<MemoryRouter><RenderSection section={sec(data)} mode="public" /></MemoryRouter>);

describe('a counting stats band', () => {
  it('wraps each countable figure’s real digits and leaves the rest as written', () => {
    const { container } = view({ layout: 'stats', columns, count: true });
    const values = [...container.querySelectorAll('.fp-stat__value')];
    expect(values.map((v) => v.textContent)).toEqual(['130', '$4', '24/7']);
    const n = values.map((v) => v.querySelector('.fp-count'));
    const first = asElement(n[0]);
    expect(first.textContent).toBe('130');
    expect(first.style.getPropertyValue('--to')).toBe('130');
    const second = asElement(n[1]);
    expect(second.textContent).toBe('4');
    expect(second.style.getPropertyValue('--to')).toBe('4');
    expect(n[2]).toBeNull();
  });

  it('a band without count, or with a non-boolean count, renders plain titles', () => {
    const { container } = view({ layout: 'stats', columns });
    expect(container.querySelector('.fp-count')).toBeNull();
    cleanup();
    const again = view({ layout: 'stats', columns, count: 'true' });
    expect(again.container.querySelector('.fp-count')).toBeNull();
  });
});

describe('the editor', () => {
  it('offers count-up on a stats base layer and removes the key when unticked', () => {
    const onChange = vi.fn<(data: Record<string, unknown>) => void>();
    const { rerender } = render(<SectionFields section={sec({ layout: 'stats', columns })} assets={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Count figures up as they scroll in' }));
    expect(onChange.mock.lastCall?.[0]).toEqual({ layout: 'stats', columns, count: true });
    rerender(<SectionFields section={sec({ layout: 'stats', columns, count: true })} assets={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Count figures up as they scroll in' }));
    expect(onChange.mock.lastCall?.[0]).toEqual({ layout: 'stats', columns });
  });

  it('hides it on other layouts and on a locale overlay', () => {
    render(<SectionFields section={sec({ layout: 'cards', columns })} assets={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: 'Count figures up as they scroll in' })).toBeNull();
    cleanup();
    render(<SectionFields section={sec({ layout: 'stats', columns })} baseData={{ layout: 'stats' }} assets={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: 'Count figures up as they scroll in' })).toBeNull();
  });
});

describe('the counting CSS', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
  const sel = '.fp-stats:not(.fp-motion--none) .fp-count {';

  it('hides the digit only inside @supports, both reduced-motion guards and outside forced colours', () => {
    const at = css.indexOf(sel);
    expect(at).toBeGreaterThan(0);
    const block = css.slice(css.lastIndexOf('@supports (animation-timeline: view())', at), at);
    expect(block.startsWith('@supports (animation-timeline: view())')).toBe(true);
    // @supports, the reduced-motion media, forced-colors: none and (ACT-1) the
    // alt-text `content` support query are all still open here: the digit is
    // hidden only where the overlay can draw.
    expect(depth(block)).toBe(4);
    expect(block.slice(block.lastIndexOf('@supports'))).toMatch(/^@supports \(content: "" \/ ""\) \{/);
    expect(block).toContain('@media screen and (prefers-reduced-motion: no-preference)');
    expect(block.slice(block.lastIndexOf('@media'))).toMatch(/^@media \(forced-colors: none\) \{/);
    expect(block).not.toMatch(/\n\}\n/);
    // Every line that hides the digit sits inside the same three guards. Two
    // do since ADR 1063 P2d: the stats figure and the bento tile's count, which
    // rides this mechanism instead of a second count-up.
    const lines = css.split('\n');
    const hides = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes('.fp-count') && /transparent/.test(l));
    expect(hides.map(({ l }) => l.trim().split(' .fp-count')[0])).toEqual([
      ':root:not([data-reduce-motion="reduce"]) .fp-stats:not(.fp-motion--none)',
      ':root:not([data-reduce-motion="reduce"]) .fp-bento:not(.fp-motion--none) .fp-bento__count',
    ]);
    for (const { l, i } of hides) {
      const pos = lines.slice(0, i).join('\n').length;
      const guard = css.slice(css.lastIndexOf('@supports (animation-timeline: view())', pos), pos);
      expect(guard.startsWith('@supports (animation-timeline: view())'), l).toBe(true);
      expect(depth(guard), l).toBe(4);
      expect(guard.slice(guard.lastIndexOf('@supports')), l).toMatch(/^@supports \(content: "" \/ ""\) \{/);
      expect(guard.slice(guard.lastIndexOf('@media')), l).toMatch(/^@media \(forced-colors: none\) \{/);
      // Only the paint is hidden, so the overlay inherits the figure's real colour.
      expect(l).toContain('-webkit-text-fill-color: transparent;');
    }
  });

  it('binds each stat to its own named timeline, with empty alt text and the real colour', () => {
    expect(css).toContain('.fp-stats:not(.fp-motion--none) .fp-stat { view-timeline: --fp-stat block; }');
    const after = css.slice(css.indexOf('.fp-stats:not(.fp-motion--none) .fp-count::after {'));
    const body = after.slice(0, after.indexOf('}'));
    expect(body).toContain('content: counter(fp-n) / "";');
    expect(body).toContain('animation-timeline: --fp-stat;');
    expect(body).toContain('-webkit-text-fill-color: currentColor;');
  });

  it('never isolates the figure (an RTL page would move the $ or % to the other side)', () => {
    expect(css).not.toMatch(/\.fp-count[^{]*\{[^}]*unicode-bidi/);
  });

  it('turns the hero activity counter off in forced colours too', () => {
    const at = css.indexOf('.fp-activity--play .fp-activity__n { position: relative; color: transparent; }');
    expect(at).toBeGreaterThan(0);
    const media = css.slice(css.lastIndexOf('@media', at), at);
    expect(media).toMatch(/^@media \(forced-colors: none\) \{/);
    // ACT-1 — and inside the alt-text `content` support query, so an engine that
    // rejects `counter() / ""` shows the plain digit instead of nothing.
    expect(depth(media)).toBe(2);
    expect(media).toContain('@supports (content: "" / "") {');
  });
});
