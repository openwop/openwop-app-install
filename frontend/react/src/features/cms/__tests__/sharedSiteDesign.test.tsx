/**
 * Shared site design fixes (myndhyve.ai design batch, phase 2, 2026-11-07).
 * These are openwop-app SITE DEFAULTS for every white-label site, taken from the
 * redesign's shared rules (`.btn .arw`, `.h1`, `.cta-note`, `.portrait`, `.essay`,
 * `.mx`, `.faq2`, `.browser .bar`). Each case pins the mechanism a reader can lose:
 *
 *  1. CTA band: the start/split title cap is the design's 14em, not 16ch.
 *  2. A primary call to action carries a trailing decorative arrow (ghost and
 *     icon buttons do not), the accessible name stays the label, and the arrow's
 *     nudge on hover exists only inside an OPEN reduced-motion guard.
 *  3. Two-column heroes use the 44px → 92px display scale.
 *  4. The CTA note follows the buttons directly, 12px under them, with no rule.
 *  5. An annotated hero picture: the wrapper takes the backdrop placement and the
 *     picture fills it, so the chips sit on the picture.
 *  6. Phone header: one account button in the header, one in the menu panel; under
 *     480px the header's is hidden, the menu's shown, and the wordmark is never
 *     truncated (the rule comes AFTER the ≤620px block that truncates it).
 *  7. Prose is 19px on 1.75; an opening paragraph that is ONE bold run becomes the
 *     kicker (and only then).
 *  8. Status tags are sentence case (the rule resets the generic mono uppercase);
 *     feature titles are 26px at 750.
 *  9. The matrix is open and ruled: no outer box, no vertical rules, a heavy head
 *     rule, the highlight column dark, and a minimum width so phones scroll.
 * 10. The two-column FAQ reads DOWN (CSS columns), items as ruled rows.
 * 11. The browser frame's address sits in a pill.
 *
 * Sabotage (each witnessed red): restore 16ch; drop the arrow or put it on ghost
 * buttons; move the hover nudge out of the motion guard; restore the old hero
 * clamp; put the note before the buttons; leave the picture absolutely placed
 * inside the wrapper; drop the menu's account slot; put the 479px block before the
 * 620px one; make every first paragraph a kicker; drop the tag's text-transform
 * reset; restore the matrix's vertical rules; restore the FAQ grid; drop the pill.
 */
import { readFileSync } from 'node:fs';
import postcss, { type AtRule, type Rule } from 'postcss';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { CtaLink } from '../CtaLink.js';

vi.mock('../../../auth/SignInButton.js', () => ({ SignInButton: () => <span data-testid="signin" /> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
const cssRoot = postcss.parse(css);
/** The declaration block of the FIRST (or LAST) rule whose selector is exactly `sel`. */
function rule(sel: string, which: 'first' | 'last' = 'first'): string {
  const i = which === 'first' ? css.indexOf(`${sel} {`) : css.lastIndexOf(`${sel} {`);
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
function view(type: string, data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: type as never, data }} mode="public" /></MemoryRouter>);
}

describe('1. CTA band title measure', () => {
  it('caps the start and split titles at 14em', () => {
    expect(rule('.fp-cta--start .fp-cta__title')).toContain('max-width: 14em;');
    expect(css).toContain('  .fp-cta--split .fp-cta__title { max-width: 14em; }');
    expect(css).not.toMatch(/\.fp-cta--(start|split) \.fp-cta__title \{ max-width: 16ch; \}/);
  });
});

describe('2. primary call-to-action arrow', () => {
  it('is on primary links only, decorative, and leaves the name as the label', () => {
    const { container } = render(<MemoryRouter>
      <CtaLink label="Book a free call" url="/p/talk" primary />
      <CtaLink label="See how it works" url="#film" />
      <CtaLink label="Watch" url="#film" primary icon={<i />} />
    </MemoryRouter>);
    const [primary, ghost, withIcon] = Array.from(container.querySelectorAll('a'));
    const arrow = primary!.querySelector('.fp-btn__arrow');
    expect(arrow?.getAttribute('aria-hidden')).toBe('true');
    expect(arrow?.querySelector('svg')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Book a free call' })).toBe(primary);
    expect(ghost!.querySelector('.fp-btn__arrow')).toBeNull();
    expect(withIcon!.querySelector('.fp-btn__arrow')).toBeNull();
  });

  it('nudges on hover only inside the reduced-motion guard', () => {
    const at = css.indexOf('.fp-btn--primary:hover .fp-btn__arrow {');
    expect(at).toBeGreaterThan(0);
    expect(openMediaAt(at)).toBe('@media screen and (prefers-reduced-motion: no-preference)');
  });
});

describe('3–5. hero', () => {
  it('3. two-column heroes run 44px → 92px', () => {
    const r = rule('.fp-hero--plan .fp-hero__title');
    const m = /clamp\(calc\(var\(--text-display\) \* (\d+) \/ (\d+)\), 6\.4vw, calc\(var\(--text-display\) \* (\d+) \/ (\d+)\)\)/.exec(r);
    expect(m, r).toBeTruthy();
    const [lo, hi] = [28 * Number(m![1]) / Number(m![2]), 28 * Number(m![3]) / Number(m![4])];
    expect([lo, hi]).toEqual([44, 92]);
  });

  it('4. the note follows the buttons, 12px under them, with no rule', () => {
    const { container } = view('hero', { heading: 'H', ctaLabel: 'Book', ctaUrl: '/p/talk', note: 'Free 15-minute call.' });
    const cta = container.querySelector('.fp-hero__cta')!;
    expect(cta.nextElementSibling?.className).toBe('fp-hero__note');
    const note = rule('.fp-hero__note');
    expect(note).toContain('margin: var(--space-3) 0 0;');
    expect(note).not.toMatch(/border/);
  });

  it('5. the annotated wrapper takes the placement and the picture fills it', () => {
    const { container } = view('hero', { heading: 'H', visual: 'image', imageToken: 'tok', alt: 'A portrait', chips: [{ text: 'Ships weekly', at: 'tl' }] });
    const wrap = container.querySelector('.fp-hero__annotated')!;
    expect(wrap.querySelector('img.fp-hero__image')).toBeTruthy();
    expect(wrap.querySelector('.fp-hero__chip--tl')?.textContent).toBe('Ships weekly');
    const w = rule('.fp-hero__annotated');
    expect(w).toContain('position: absolute;');
    expect(w).toContain('width: min(48%, 620px);');
    const img = rule('.fp-hero__annotated .fp-hero__image');
    expect(img).toContain('position: static;');
    expect(img).toContain('inline-size: 100%;');
  });
});

describe('6. phone header', () => {
  it('puts one account button in the header and one in the menu panel', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))));
    const { PublicShell } = await import('../../../chrome/PublicShell.js');
    const { container } = render(<MemoryRouter><PublicShell><div>body</div></PublicShell></MemoryRouter>);
    const header = container.querySelector('.public-shell-header')!;
    expect(header.querySelector('.public-shell-actions > .public-shell-signin [data-testid="signin"]')).toBeTruthy();
    expect(header.querySelector('.public-menu__footer .public-menu__signin [data-testid="signin"]')).toBeTruthy();
  });

  it('under 480px shows the menu slot and keeps the wordmark whole, after the 620px block', () => {
    const block = css.indexOf('@media (max-width: 479px) {\n  .public-shell:not(.site-shell) .public-shell-signin { display: none; }');
    expect(block).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(css.indexOf('@media (max-width: 620px) {\n  .public-shell-demochip'));
    const body = css.slice(block, css.indexOf('\n}\n', block));
    expect(body).toContain('.public-shell:not(.site-shell) .public-menu__signin { display: flex; }');
    expect(body).toContain('.public-shell-brand .app-gate-product { overflow: visible; text-overflow: clip; }');
    expect(rule('.public-menu__signin')).toContain('display: none;');
  });
});

describe('7. prose', () => {
  const paragraphs = (text: string) => {
    const { container } = view('richText', { text });
    return Array.from(container.querySelectorAll('p.fp-prose__p')).map((p) => p.className);
  };

  it('makes an opening all-bold paragraph the kicker, and nothing else', () => {
    expect(paragraphs("**You've heard it.**\n\nThe rest.")).toEqual(['fp-prose__p fp-prose__p--kicker', 'fp-prose__p']);
    expect(paragraphs('Plain start.\n\n**Bold later.**')).toEqual(['fp-prose__p', 'fp-prose__p']);
    expect(paragraphs('**Bold** then plain.')).toEqual(['fp-prose__p']);
  });

  it('sets the essay measure: 19px on 1.75, the kicker at 22px / 600', () => {
    const p = rule('.fp-prose__p');
    expect(p).toContain('font-size: calc(var(--text-lg) * 19 / 16);');
    expect(p).toContain('line-height: 1.75;');
    const k = rule('.fp-prose__p--kicker');
    expect(k).toContain('font-size: calc(var(--text-subtitle) * 22 / 18);');
    expect(k).toContain('font-weight: var(--weight-head);');
  });
});

describe('8. tags and feature titles', () => {
  it('tags are sentence case: the last .fp-tag rule resets the mono uppercase', () => {
    const tag = rule('.fp-tag', 'last');
    for (const d of ['font-family: var(--sans);', 'letter-spacing: 0;', 'text-transform: none;', 'font-size: calc(var(--text-sm) * 12.5 / 13);']) expect(tag).toContain(d);
  });

  it('feature titles are 26px at 750', () => {
    const t = rule('.fp-feature__title');
    expect(t).toContain('font-size: calc(var(--text-title) * 13 / 11);');
    expect(t).toContain('font-weight: calc(var(--weight-marquee) + 50);');
  });
});

describe('9–11. matrix, FAQ, browser frame', () => {
  it('9. the matrix is open and ruled, and scrolls on a phone', () => {
    expect(rule('.fp-matrix__scroll')).not.toMatch(/border/);
    expect(rule('.fp-matrix__table')).toContain('min-width: 900px;');
    expect(rule('.fp-matrix__cell')).not.toContain('border-inline-start');
    expect(rule('.fp-matrix__colhead')).toContain('border-bottom: 2px solid var(--ink);');
    expect(rule('.fp-matrix__colhead--hl')).toContain('background: var(--tone-inverse-bg);');
    expect(rule('.fp-matrix__cell--hl')).toContain('background: var(--tone-inverse-bg);');
  });

  it('10. the two-column FAQ reads down, items as ruled rows', () => {
    const at = css.indexOf('.fp-faq--cols2 { display: block; columns: 2;');
    expect(at).toBeGreaterThan(0);
    expect(openMediaAt(at)).toBe('@media (min-width: 900px)');
    expect(css).not.toContain('.fp-faq--cols2 { grid-template-columns');
    expect(rule('.fp-faq--cols2 .fp-faq__item')).toContain('background: transparent;');
  });

  it('11. the browser frame shows its address in a pill', () => {
    const u = rule('.fp-browser__url');
    expect(u).toContain('background: var(--paper);');
    expect(u).toContain('border-radius: var(--space-1-5);');
    expect(u).toContain('max-inline-size: 320px;');
  });
});
