/**
 * ADR 1050 — CMS follow-ups as a visitor and an editor meet them.
 * Guards:
 * - D1: five and six steps get their count class (one row from 1024px, 3 + n
 *   on a tablet); four keep their exact markup;
 * - D2: the hub is drawn in ONE physical coordinate space in LTR and RTL: each
 *   place's --hub-x/--hub-y is its spoke's x2/y2, the CSS positions with
 *   left/top (never an inline-start offset, which flips while the translate
 *   does not), and the RTL rule mirrors the lines and the places together;
 * - D3: the spokes draw on pathLength 1 (dash 1, offset 1 → 0), behind the
 *   motion guard;
 * - D5: an image section takes the same tone band classes as the others, an
 *   absent tone renders exactly as before, and the editor's tone control writes
 *   and clears the key.
 *
 * Ceiling: jsdom applies no stylesheet, so the CSS half is a contract read of
 * global.css. The rendered grid and the mirrored hub are not exercised here.
 * "Behind the motion guard" is checked with `openAt` (the blocks still OPEN at
 * the rule), not by finding a guard that opened earlier (grade-tests wave 88).
 *
 * Sabotage-witnessed (2026-11-03; re-probed /grade-tests wave 88): reverting
 * pathLength to 100; dropping or widening the n5/n6 classes; the tablet or wide
 * grid; flipping or rotating the hub geometry; an inline-start offset or a broken
 * RTL place rule; closing the motion guard before the draw rule; a dash on the
 * resting spoke; dropping the image tone, accepting an unknown tone, the editor
 * writing no tone or clearing it to `tone: undefined` instead of removing the
 * key; and a tone control on an overlay or an untoned type each red a case.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(() => { cleanup(); document.documentElement.removeAttribute('dir'); });

function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}
const steps = (n: number): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => ({ title: `Step ${i + 1}`, text: `Do thing ${i + 1}.` }));

const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
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
/** The rendered element matching `selector`, narrowed without a cast. */
function el<T extends Element>(root: ParentNode, selector: string, type: new () => T): T {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`no ${selector}`);
  return found;
}
const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('ADR 1050 D1 — steps fit their count', () => {
  it('gives five steps the five-column class, circle numbers kept', () => {
    const { container } = view('columns', { layout: 'steps', numbers: 'circle', columns: steps(5) });
    const section = el(container, 'section.fp-steps', HTMLElement);
    expect(section.classList.contains('fp-steps--n5')).toBe(true);
    expect(section.classList.contains('fp-steps--circle')).toBe(true);
    expect(section.querySelectorAll('.fp-step')).toHaveLength(5);
  });
  it('gives six steps the six-column class', () => {
    const { container } = view('columns', { layout: 'steps', columns: steps(6) });
    expect(container.querySelector('section.fp-steps')?.classList.contains('fp-steps--n6')).toBe(true);
  });
  it('leaves four steps unchanged', () => {
    const { container } = view('columns', { layout: 'steps', numbers: 'circle', columns: steps(4) });
    expect(container.querySelector('section.fp-steps')?.className).toBe('cms-public-section fp-section fp-steps fp-steps--circle');
  });
  it('lays five out as one row from 1024px and three columns from 600px', () => {
    const tablet = css.slice(css.indexOf('@media (min-width: 600px) {\n  .fp-steps--n5'));
    expect(tablet.slice(0, tablet.indexOf('}\n}'))).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    const wide = css.slice(css.indexOf('@media (min-width: 1024px) {\n  .fp-steps--n5'));
    const block = wide.slice(0, wide.indexOf('}\n}'));
    expect(block).toContain('.fp-steps--n5 .fp-steps__list { grid-template-columns: repeat(5, minmax(0, 1fr)); }');
    expect(block).toContain('.fp-steps--n6 .fp-steps__list { grid-template-columns: repeat(6, minmax(0, 1fr)); }');
    // minmax(0, …) tracks, never a fixed minimum, so nothing overflows sideways.
    expect(block).not.toMatch(/minmax\(\d+px/);
  });
});

const HUB = {
  center: { label: 'Your agent' },
  spokes: [{ label: 'Team chat' }, { label: 'Customers' }, { label: 'The phone' }, { label: 'Code' }, { label: 'Overnight' }],
};

describe('ADR 1050 D2/D3 — the hub in both directions', () => {
  it.each(['ltr', 'rtl'])('%s: each place sits on its own spoke end, in one coordinate space', (dir) => {
    document.documentElement.setAttribute('dir', dir);
    const { container } = view('hero', { heading: 'Everywhere.', visual: 'hub', hub: HUB });
    const lines = Array.from(container.querySelectorAll('.fp-hub__spoke'));
    const places = Array.from(container.querySelectorAll<HTMLElement>('.fp-hub__place'));
    expect(lines).toHaveLength(5);
    expect(places).toHaveLength(5);
    places.forEach((p, i) => {
      expect(p.style.getPropertyValue('--hub-x')).toBe(`${lines[i]!.getAttribute('x2')}%`);
      expect(p.style.getPropertyValue('--hub-y')).toBe(`${lines[i]!.getAttribute('y2')}%`);
    });
    // The first place is at the top centre, whatever the direction.
    expect(lines[0]!.getAttribute('x2')).toBe('50');
    expect(lines.every((l) => l.getAttribute('x1') === '50' && l.getAttribute('y1') === '50')).toBe(true);
  });
  it('positions the centre and the places physically, and mirrors lines and places together in RTL', () => {
    const center = rule('.fp-hub__center');
    const place = rule('.fp-hub__place');
    expect(center).toContain('left: 50%; top: 50%;');
    expect(place).toContain('left: var(--hub-x); top: var(--hub-y);');
    for (const r of [center, place]) {
      expect(r).not.toMatch(/inset-inline|inset-block/);
      expect(r).toContain('transform: translate(-50%, -50%)');
    }
    expect(css).toContain(':root[dir="rtl"] .fp-hub__lines { transform: scaleX(-1); }');
    expect(css).toContain(':root[dir="rtl"] .fp-hub__place { left: calc(100% - var(--hub-x)); }');
  });
  it('draws each spoke on pathLength 1, only behind the motion guard', () => {
    const { container } = view('hero', { heading: 'Everywhere.', visual: 'hub', hub: HUB });
    for (const l of container.querySelectorAll('.fp-hub__spoke')) expect(l.getAttribute('pathLength')).toBe('1');
    const draw = css.indexOf('.fp-hub__spoke { stroke-dasharray: 1; stroke-dashoffset: 1; animation: fp-hub-draw');
    expect(draw).toBeGreaterThan(0);
    const guard = css.slice(css.lastIndexOf('@media', draw), draw);
    expect(guard).toContain('@media screen and (prefers-reduced-motion: no-preference)');
    expect(guard).toContain(':root:not([data-reduce-motion="reduce"]) .cms-public-section:not(.fp-motion--none)');
    // …and that block is still OPEN at the draw rule, not closed ahead of it.
    expect(openAt(css, draw)).toContain('@media screen and (prefers-reduced-motion: no-preference)');
    expect(css).toContain('@keyframes fp-hub-draw { to { stroke-dashoffset: 0; } }');
    // The resting rule draws the finished line (no dash outside the guard).
    expect(rule('.fp-hub__spoke')).not.toContain('stroke-dash');
  });
});

describe('ADR 1050 D5 — image tone', () => {
  const IMG = { token: 'tok_shot', alt: 'The dashboard', heading: 'See it' };
  it('paints the same band classes as the other toned sections', () => {
    const { container } = view('image', { ...IMG, tone: 'inverse' });
    const section = el(container, 'section.fp-figure', HTMLElement);
    expect(section.classList.contains('fp-tone')).toBe(true);
    expect(section.classList.contains('fp-tone--inverse')).toBe(true);
    cleanup();
    const rich = el(view('richText', { text: 'x', tone: 'inverse' }).container, 'section', HTMLElement);
    expect(rich.className).toContain(' fp-tone fp-tone--inverse');
  });
  it('renders exactly as before without a tone, or with an unknown one', () => {
    const plain = view('image', IMG).container.innerHTML;
    cleanup();
    expect(view('image', { ...IMG, tone: 'neon' }).container.innerHTML).toBe(plain);
    expect(plain).not.toContain('fp-tone');
  });
  it('the editor writes the tone and "Default" removes the key', () => {
    const onChange = vi.fn<(data: Record<string, unknown>) => void>();
    const data = { ...IMG, tone: 'muted' };
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'image', data }} onChange={onChange} assets={[]} /></MemoryRouter>);
    const select = screen.getByRole('combobox', { name: 'Background' });
    if (!(select instanceof HTMLSelectElement)) throw new Error('not a select');
    expect(select.value).toBe('muted');
    fireEvent.change(select, { target: { value: 'accent' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...IMG, tone: 'accent' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(IMG);
    // REMOVES the key: `toHaveBeenLastCalledWith` treats `tone: undefined` as
    // absent, so check the key itself.
    const cleared = onChange.mock.lastCall?.[0];
    expect(cleared && Object.keys(cleared).sort()).toEqual(Object.keys(IMG).sort());
  });
  it('offers no tone control on a locale overlay or an untoned type', () => {
    const noop = (): void => undefined;
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'image', data: IMG }} baseData={IMG} onChange={noop} assets={[]} /></MemoryRouter>);
    expect(screen.queryByRole('combobox', { name: 'Background' })).toBeNull();
    cleanup();
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'hero', data: { heading: 'H' } }} onChange={noop} assets={[]} /></MemoryRouter>);
    expect(screen.queryByRole('combobox', { name: 'Background' })).toBeNull();
  });
});
