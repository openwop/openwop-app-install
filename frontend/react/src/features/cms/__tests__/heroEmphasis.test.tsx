/**
 * ADR 1038 P2 — the hero heading's marked words struck through, underlined or
 * highlighted.
 * Guards:
 * - the style is a modifier on the hero section; the words stay one `<em>` and
 *   the heading reads the same (no markers, no extra text);
 * - the default accent adds no class, so a hero that never chose keeps its markup;
 * - the editor offers the style on the base layer only, and "Accent" removes the key;
 * - struck words are `<em><s>`, the meaning a sighted reader gets;
 * - the CSS (which jsdom cannot run) draws on the motion path only (the drawing
 *   rule sits inside the reduced-motion media, checked still open by brace depth
 *   with comments stripped), opts out under `motion: none`, and keeps every mark
 *   (strike, underline, highlight) in forced colours and in print.
 *
 * Sabotage-witnessed (w87 probes): adding the class for `accent`, a misspelt
 * class, no `struck` prop, no `<s>`, showing the select on an overlay, storing
 * the key for Accent, a select that ignores the stored value, dropping the
 * `fp-motion--none` opt-out or the in-app guard, and losing the forced-colours
 * strike or highlight or the print colour adjust each turn a case red; so do
 * (after w87) the media block closed inline, no forced-colours underline, and a
 * print rule that drops a style.
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

/** Open-minus-closed braces in a CSS slice, comments stripped: how many blocks are still open at its end. */
const depth = (s: string): number => {
  const t = s.replace(/\/\*[\s\S]*?\*\//g, '');
  return (t.match(/\{/g)?.length ?? 0) - (t.match(/\}/g)?.length ?? 0);
};

const sec = (data: Record<string, unknown>): Section => ({ sectionId: 's', type: 'hero', data });
const view = (data: Record<string, unknown>) =>
  render(<MemoryRouter><RenderSection section={sec(data)} mode="public" /></MemoryRouter>);

describe('a hero with marked words', () => {
  it('puts the style on the section and keeps the words as one <em>', () => {
    const { container } = view({ heading: 'The business is taking *months.*', visual: 'none', emphasis: 'strike' });
    expect(container.querySelector('section')?.classList.contains('fp-em--strike')).toBe(true);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('The business is taking months.');
    expect(h1.querySelector('em')!.textContent).toBe('months.');
    // Struck words are <s>, so assistive tech reads them as struck, not as their opposite.
    expect(h1.querySelector('em > s')!.textContent).toBe('months.');
  });

  it('adds nothing for the default accent', () => {
    for (const emphasis of [undefined, 'accent']) {
      const { container } = view({ heading: 'Taking *months.*', visual: 'none', ...(emphasis ? { emphasis } : {}) });
      expect(container.querySelector('section')!.className).not.toMatch(/fp-em--/);
      cleanup();
    }
  });
});

describe('the editor', () => {
  it('offers the style on the base layer; Accent removes the key', () => {
    const onChange = vi.fn<(data: Record<string, unknown>) => void>();
    render(<SectionFields section={sec({ heading: 'H', emphasis: 'strike' })} assets={[]} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Marked words' });
    expect(select).toBeInstanceOf(HTMLSelectElement);
    if (!(select instanceof HTMLSelectElement)) return;
    expect(select.value).toBe('strike');
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange.mock.lastCall?.[0]).toEqual({ heading: 'H' });
    fireEvent.change(select, { target: { value: 'highlight' } });
    expect(onChange.mock.lastCall?.[0]).toEqual({ heading: 'H', emphasis: 'highlight' });
  });

  it('hides the style on a locale overlay', () => {
    render(<SectionFields section={sec({ heading: 'Hola' })} baseData={{ heading: 'H' }} assets={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Marked words' })).toBeNull();
  });
});

describe('the emphasis CSS', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');

  it('draws only on the motion path, and opts out under motion none', () => {
    // Every selector line of the drawing rule carries both guards (no vacuous pass).
    const at = css.indexOf('{ animation: fp-em-draw');
    expect(at).toBeGreaterThan(0);
    const rule = css.slice(css.lastIndexOf('@media screen', at), at);
    // The reduced-motion media is still open at the drawing rule.
    expect(rule.startsWith('@media screen and (prefers-reduced-motion: no-preference) {')).toBe(true);
    expect(depth(rule)).toBe(1);
    const selectors = rule.split('\n').filter((l) => l.includes('fp-em--'));
    expect(selectors).toHaveLength(3);
    for (const l of selectors) {
      expect(l).toContain(':root:not([data-reduce-motion="reduce"])');
      expect(l).toContain('.fp-hero:not(.fp-motion--none)');
    }
    const block = css.slice(css.indexOf('@keyframes fp-em-draw'));
    expect(block.slice(0, block.indexOf('@media (forced-colors'))).toContain('@media screen and (prefers-reduced-motion: no-preference)');
  });

  it('keeps every mark in forced colours and in print', () => {
    const fAt = css.indexOf('@media (forced-colors: active) {\n  .fp-hero.fp-em--strike');
    expect(fAt).toBeGreaterThan(0);
    const forced = css.slice(fAt, css.indexOf('\n}\n', fAt));
    expect(forced).toMatch(/fp-em--strike[^}]*line-through/);
    expect(forced).toMatch(/fp-em--underline[^}]*text-decoration: underline;/);
    expect(forced).toMatch(/fp-em--highlight[^}]*background-color: Mark;/);
    const pAt = css.indexOf('@media print {\n  .fp-hero.fp-em--strike');
    expect(pAt).toBeGreaterThan(0);
    const print = css.slice(pAt, css.indexOf('}', pAt));
    expect(print).toContain('print-color-adjust: exact');
    for (const style of ['strike', 'underline', 'highlight']) expect(print).toContain(`.fp-hero.fp-em--${style} .fp-hero__title .fp-em`);
  });
});
