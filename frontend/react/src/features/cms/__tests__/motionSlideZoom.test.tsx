/**
 * ADR 1038 P6 — sideways and zoom section motions.
 * Guards:
 * - the editor offers `slide-start`, `slide-end` and `zoom`, and a section that
 *   chose one gets its `fp-motion--*` class;
 * - the CSS (which jsdom cannot run): every new rule sits inside the ADR 1029
 *   guards (scroll timelines, screen, no reduced motion, the in-app setting) and
 *   ends at `entry 100%`; `slide-end` travels the other way; directions flip in
 *   RTL; the public page and the custom-domain site clip horizontal overflow, so
 *   a section waiting off to one side never adds a horizontal scrollbar;
 * - the custom-domain stylesheet honours the same three values;
 * - the editor preview mirrors the app's `dir` and in-app reduced-motion setting,
 *   both at mount and when either changes later (the MutationObserver path).
 *
 * "Inside the guards" is checked with `openAt`, which walks the braces and
 * returns the blocks still OPEN at a rule, so a block that opens before a rule
 * and closes ahead of it does not count (grade-tests wave 87/88 lesson).
 *
 * Sabotage-witnessed (2026-11-03; re-probed /grade-tests wave 88): dropping the
 * overflow clip on either surface, moving the slide, slide-end or zoom rule out of
 * the guards (SPA or custom-domain), dropping the site zoom rule, sending
 * slide-end the same way, removing the RTL flip, changing the range, dropping an
 * editor option or a motion class, and dropping `dir`/`data-reduce-motion` from
 * the preview's mirror or its observer each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import { PublicPreviewFrame } from '../PublicPreviewFrame.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);
const src = join(__dirname, '..', '..', '..');
const css = readFileSync(join(src, 'styles', 'global.css'), 'utf8');
const site = readFileSync(join(src, 'site-runtime', 'site.css'), 'utf8');

const SUPPORTS = '@supports (animation-timeline: view())';
const MEDIA = '@media screen and (prefers-reduced-motion: no-preference)';
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
/** Asserts `anchor` occurs once in `text` and sits inside both motion guards. */
function expectGuarded(text: string, anchor: string): void {
  const at = text.indexOf(anchor);
  expect(at, anchor).toBeGreaterThan(0);
  expect(text.indexOf(anchor, at + 1), anchor).toBe(-1);
  expect(openAt(text, at), anchor).toEqual(expect.arrayContaining([SUPPORTS, MEDIA]));
}

describe('the new motions', () => {
  it('are offered by the editor and reach the section class', () => {
    render(<SectionFields section={{ sectionId: 's', type: 'richText', data: { body: 'x', motion: 'zoom' } }} assets={[]} onChange={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: 'Motion' });
    if (!(select instanceof HTMLSelectElement)) throw new Error('not a select');
    expect([...select.options].map((o) => o.value)).toEqual(expect.arrayContaining(['slide-start', 'slide-end', 'zoom']));
    cleanup();
    for (const m of ['slide-start', 'slide-end', 'zoom']) {
      const s: Section = { sectionId: 's', type: 'richText', data: { body: 'Hello', motion: m } };
      const { container } = render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>);
      expect(container.querySelector('section')?.className, m).toContain(`fp-motion--${m}`);
      cleanup();
    }
  });
});

describe('the motion CSS', () => {
  const guarded = css.slice(css.indexOf('@supports (animation-timeline: view())', css.indexOf('ADR 1029 — section scroll motion')));
  const block = guarded.slice(0, guarded.indexOf('/* Landing flash'));

  it('keeps every new rule inside the ADR 1029 guards, ending at entry 100%', () => {
    expect(block).toContain('@media screen and (prefers-reduced-motion: no-preference)');
    const lines = block.split('\n').filter((l) => /fp-motion--(slide-start|slide-end|zoom)/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const l of lines) expect(l).toContain(':root:not([data-reduce-motion="reduce"])');
    const at = block.indexOf('animation-name: fp-slide');
    expect(at).toBeGreaterThan(0);
    const rule = block.slice(block.lastIndexOf('}', at), block.indexOf('}', at));
    // One rule carries all three values (zoom swaps only the keyframes), ending at entry 100%.
    expect(rule).toContain('.fp-motion--zoom');
    expect(rule).toContain('animation-range: entry 0% entry 100%');
    // …and it sits inside the reduced-motion media block, not after it closes.
    const media = block.indexOf('@media screen and (prefers-reduced-motion: no-preference)');
    const before = block.slice(media, at);
    expect(media).toBeGreaterThanOrEqual(0);
    expect(before.split('{').length - before.split('}').length).toBeGreaterThan(1);
    expect(css.slice(0, css.indexOf('ADR 1029 — section scroll motion'))).not.toMatch(/fp-motion--(slide|zoom)/);
    // Each of the three rules is inside BOTH guards where it is declared.
    expectGuarded(css, 'animation-name: fp-slide;');
    expectGuarded(css, '.cms-public-page > .cms-pv-section > .cms-public-section.fp-motion--slide-end { --fp-slide: var(--slide-distance); }');
    expectGuarded(css, '.cms-public-page > .cms-pv-section > .cms-public-section.fp-motion--zoom { animation-name: fp-zoom; }');
  });

  it('slides the other way for slide-end and flips in RTL', () => {
    expect(block).toMatch(/fp-motion--slide-end \{ --fp-slide: var\(--slide-distance\); \}/);
    expect(css).toContain(':root[dir="rtl"] .cms-public-page { --fp-dir: -1; }');
    expect(css).toMatch(/@keyframes fp-slide \{ from \{[^}]*var\(--fp-dir, 1\)/);
  });

  it('clips horizontal overflow on the page and the custom-domain site', () => {
    expect(css).toContain('.cms-public-page { overflow-x: clip; }');
    expect(site).toContain('[data-owp-site] { overflow-x: clip; }');
  });

  it('the editor preview mirrors dir and the in-app reduced-motion setting', async () => {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('data-reduce-motion', 'reduce');
    try {
      const { container } = render(<PublicPreviewFrame title="Preview">{null}</PublicPreviewFrame>);
      const frame = container.querySelector('iframe');
      if (!frame) throw new Error('no iframe');
      const root = frame.contentDocument?.documentElement;
      if (!root) throw new Error('no frame document');
      // At mount: copied by the first sync.
      expect(root.getAttribute('dir')).toBe('rtl');
      expect(root.getAttribute('data-reduce-motion')).toBe('reduce');
      // Let jsdom's queued about:blank `load` (which also syncs) fire FIRST, so the
      // changes below can only reach the frame through the MutationObserver.
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); });
      // Each attribute changes in its OWN step: one sync copies both, so a `dir`
      // change batched with a reduce-motion change would ride that mutation's
      // sync and never show the observer watches `dir` itself.
      document.documentElement.setAttribute('dir', 'ltr');
      // Observer records are delivered on a microtask: drain microtasks only (no
      // timer turn, so a late load event cannot do the observer's job).
      await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
      expect(root.getAttribute('dir')).toBe('ltr');
      expect(root.getAttribute('data-reduce-motion')).toBe('reduce');
      document.documentElement.removeAttribute('data-reduce-motion');
      await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
      expect(root.hasAttribute('data-reduce-motion')).toBe(false);
      document.documentElement.setAttribute('data-reduce-motion', 'reduce');
      await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
      expect(root.getAttribute('data-reduce-motion')).toBe('reduce');
    } finally {
      document.documentElement.removeAttribute('dir');
      document.documentElement.removeAttribute('data-reduce-motion');
    }
  });

  it('the custom-domain stylesheet honours the same three values under the same guards', () => {
    const b = site.slice(site.indexOf('/* ADR 1029 motion, keyed on the hook'));
    for (const m of ['slide-start', 'slide-end', 'zoom']) expect(b).toContain(`[data-owp-motion="${m}"]`);
    // Each value's rule is inside BOTH guards where it is declared (not merely
    // after a block that opened earlier): the shared slide rule, slide-end's
    // opposite direction and zoom's own keyframes.
    expectGuarded(site, 'animation-name: owp-site-slide;');
    expectGuarded(site, '[data-owp-site] [data-owp-motion="slide-end"] { --owp-slide: var(--slide-distance); }');
    expectGuarded(site, '[data-owp-site] [data-owp-motion="zoom"] { animation-name: owp-site-zoom; }');
    expect(b.indexOf('@media screen and (prefers-reduced-motion: no-preference)')).toBeGreaterThan(0);
  });
});
