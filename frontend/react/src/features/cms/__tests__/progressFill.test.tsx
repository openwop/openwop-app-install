/**
 * ADR 1038 P4 — a progress section's bars fill as they enter view.
 * Guards:
 * - there is no new field: every progress section fills unless its motion is
 *   `none` (the same rule as the stats count), and the bar stays decorative;
 * - the CSS (which jsdom cannot run) reads a NAMED timeline declared on the card,
 *   never an anonymous `view()` (`.fp-progress` clips, so `view()` on the fill
 *   would watch the bar's own box and never fill) and never the 6px bar's own
 *   range (over in one wheel tick, so nobody saw it move);
 * - the fill grows from the inline start in both directions and sits inside
 *   `@supports` + both reduced-motion guards (the OS media query, checked open by
 *   brace depth with comments stripped, and the in-app
 *   `:root:not([data-reduce-motion="reduce"])` prefix on the fill and card rules),
 *   so everywhere else the bar shows its value.
 *
 * The decorative-bar line overlaps SectionRenderer.sectionStyles "progress cards
 * show the eyebrow and a decorative bar"; this case's own claim is the
 * `fp-motion--none` opt-out on a progress section.
 *
 * Ceiling: the filling is CSS. Measured in Chromium (2026-11-03): scaleX 0 below
 * the fold, partial while the card enters, 1 once it is in, `none` under reduced
 * motion. Sabotage-witnessed (w87 probes): an anonymous `view()` on the fill, the
 * timeline on the 6px bar, another keyframe, no left origin, no RTL origin rule,
 * no `aria-hidden`, and no `none` motion each turn a case red; so do (after w87)
 * the in-app guard dropped, the media block closed early, and `@supports {}`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const sec = (data: Record<string, unknown>): Section => ({ sectionId: 's', type: 'columns', data });
const view = (data: Record<string, unknown>) => render(
  <MemoryRouter><RenderSection section={sec(data)} mode="public" /></MemoryRouter>,
);

/** Open-minus-closed braces in a CSS slice, comments stripped: how many blocks are still open at its end. */
const depth = (s: string): number => {
  const t = s.replace(/\/\*[\s\S]*?\*\//g, '');
  return (t.match(/\{/g)?.length ?? 0) - (t.match(/\}/g)?.length ?? 0);
};

describe('a progress section', () => {
  it('keeps a decorative bar, and only motion none carries the opt-out class', () => {
    const cols = [{ title: 'Beta', progress: 0.8 }];
    const { container } = view({ layout: 'progress', columns: cols });
    const section = container.querySelector('section')!;
    expect(section.classList.contains('fp-cols--progress')).toBe(true);
    expect(section.classList.contains('fp-motion--none')).toBe(false);
    expect(container.querySelector('.fp-progress')!.getAttribute('aria-hidden')).toBe('true');
    cleanup();
    const off = view({ layout: 'progress', motion: 'none', columns: cols });
    expect(off.container.querySelector('section')!.classList.contains('fp-motion--none')).toBe(true);
  });
});

describe('the fill CSS', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
  // The in-app reduce-motion guard is part of the selector, so dropping it fails the lookup.
  const sel = ':root:not([data-reduce-motion="reduce"]) .fp-cols--progress:not(.fp-motion--none) .fp-progress__fill {';
  const bodyOf = (): string => { const at = css.indexOf(sel); expect(at).toBeGreaterThan(0); return css.slice(at, css.indexOf('}', at)); };

  it('reads the named timeline declared on the card, not view() and not the 6px bar', () => {
    const body = bodyOf();
    expect(css).toContain(':root:not([data-reduce-motion="reduce"]) .fp-cols--progress:not(.fp-motion--none) .fp-col { view-timeline: --fp-bar block; }');
    expect(css).not.toContain('.fp-progress { view-timeline');
    expect(body).toContain('animation-timeline: --fp-bar;');
    expect(body).not.toContain('view()');
    expect(body).toContain('animation-name: fp-fill;');
  });

  it('grows from the inline start in both directions, only inside the guards', () => {
    const body = bodyOf();
    expect(body).toContain('transform-origin: left;');
    expect(css).toContain(':root[dir="rtl"]:not([data-reduce-motion="reduce"]) .fp-cols--progress:not(.fp-motion--none) .fp-progress__fill { transform-origin: right; }');
    const at = css.indexOf(sel);
    const before = css.slice(css.lastIndexOf('@supports', at), at);
    expect(before.startsWith('@supports (animation-timeline: view())')).toBe(true);
    expect(before).toContain('@media screen and (prefers-reduced-motion: no-preference)');
    expect(before).not.toMatch(/\n\}\n/);
    // @supports and the reduced-motion media are both still open at the fill rule.
    expect(depth(before)).toBe(2);
  });
});
