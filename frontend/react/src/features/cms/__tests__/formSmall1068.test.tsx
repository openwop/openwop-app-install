/**
 * ADR 1068 D3 (myndhyve.ai design batch, P3d-3): the page half.
 *
 *  1. A column's call to action (`ctaLabel`/`ctaUrl`, the fields the pricing list
 *     draws as a button) renders a visible action line (label + decorative arrow)
 *     in the panels and cards layouts; an unsafe target renders nothing; a card
 *     with one is NOT also a whole-card link (links never nest).
 *  2. A board lane's `text` renders under the lane title.
 *  3. The `arrow` icon slug draws an arrow, not the node motif.
 *  4. `headSize: 'sm'` adds `fp-head--sm`, which sets the smaller clamp.
 *  5. The form card: a note under the form; a 576px card column at the end of
 *     the shell; 50px fields with a 12px radius and an accent focus ring
 *     (`--clay-strong` border and a 4px ring); only the first two short fields
 *     share a row.
 *  6. Under a split head the FAQ picture sits under the heading (first column)
 *     and the questions take the second column across both rows (security page).
 *
 * Sabotage (each witnessed red): drop ActionLink from panels or cards; render an
 * unsafe link; keep the whole-card link when a link is set; drop the lane text;
 * unmap `arrow`; drop the headSize class; drop the form note; lose the 576px
 * column; drop the focus ring; drop the pairing rule; move the arrow nudge (LTR
 * or the RTL mirror) out of the motion guard; put the FAQ picture above the head.
 */
import { readFileSync } from 'node:fs';
import postcss, { type AtRule, type Rule } from 'postcss';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { SectionType } from '../cmsClient.js';

vi.mock('../../forms/render/PublicFormRenderer.js', () => ({ PublicFormRenderer: () => <form data-testid="form" /> }));

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
/** The @media chain of EVERY rule whose selector contains `part` (so a second,
 *  unguarded copy, e.g. the RTL mirror, cannot hide behind the first). */
function guardsOfAll(part: string): string[] {
  const out: string[] = [];
  cssRoot.walkRules((r) => {
    if (!r.selector.includes(part)) return;
    const chain: string[] = [];
    for (let p = r.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule' && (p as AtRule).name === 'media') chain.unshift(`@media ${(p as AtRule).params}`);
    }
    out.push(chain.join(' > '));
  });
  return out;
}
const view = (type: SectionType, data: Record<string, unknown>) =>
  render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);

describe('1. column call to action', () => {
  const LINK = { ctaLabel: 'For agencies', ctaUrl: '/p/agencies' };

  it('renders an action line in panels and in cards', () => {
    const p = view('columns', { layout: 'panels', columns: [{ title: 'Agencies', text: 'Per client.', ...LINK }] });
    const a = screen.getByRole('link', { name: 'For agencies' });
    expect(a.getAttribute('href')).toBe('/p/agencies');
    expect(a.querySelector('.fp-col__link-arrow')?.getAttribute('aria-hidden')).toBe('true');
    p.unmount();
    view('columns', { layout: 'cards', columns: [{ title: 'Campaign Studio', text: 'Built in.', ctaLabel: 'See Campaign Studio', ctaUrl: '/p/campaign-studio' }] });
    expect(screen.getByRole('link', { name: 'See Campaign Studio' }).getAttribute('href')).toBe('/p/campaign-studio');
  });

  it('never nests links, and drops an unsafe target', () => {
    const { container } = view('columns', { layout: 'cards', columns: [
      { title: 'Studio', text: 'Built in.', href: '/p/campaign-studio', ctaLabel: 'See it', ctaUrl: '/p/campaign-studio' },
      { title: 'Bad', text: 'x', ctaLabel: 'Click', ctaUrl: 'javascript:alert(1)' },
    ] });
    // Positive control: the card's own action line renders and carries the target.
    expect(screen.getByRole('link', { name: 'See it' }).getAttribute('href')).toBe('/p/campaign-studio');
    expect(container.querySelectorAll('a a')).toHaveLength(0);
    expect(container.querySelector('a.fp-card--link')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Click' })).toBeNull();
  });

  it('nudges the arrow only on the motion path', () => {
    // Two rules move the arrow: the LTR nudge and its RTL mirror. Both must be guarded.
    const guards = guardsOfAll('.fp-col__link:hover .fp-col__link-arrow');
    expect(guards).toHaveLength(2);
    for (const g of guards) expect(isMotionGuard(g), g).toBe(true);
  });
});

describe('2–4. board text, arrow slug, headSize', () => {
  it('renders a lane line under its title', () => {
    const { container } = view('columns', { layout: 'board', columns: [{ title: 'Works today', text: 'Printed apps live today.', items: [{ label: 'Sign-in' }] }] });
    const lane = container.querySelector('.fp-lane')!;
    expect(lane.querySelector('h3 + .fp-lane__text')?.textContent).toBe('Printed apps live today.');
  });

  it('draws the arrow slug as an icon', () => {
    const { container } = view('columns', { layout: 'cards', columns: [{ title: 'Next', text: 'x', icon: 'arrow' }] });
    // The arrow's own path, not the node motif the fallback draws for an unknown slug.
    expect(container.querySelectorAll('.fp-card .fp-glyph svg path[d="m12 5 7 7-7 7"]')).toHaveLength(1);
  });

  it("adds fp-head--sm for headSize 'sm' and sets the smaller clamp", () => {
    const { container } = view('columns', { layout: 'cards', heading: 'Built in', headSize: 'sm', columns: [{ title: 'A', text: 'a' }] });
    expect(container.querySelector('section.fp-head--sm')).toBeTruthy();
    expect(rule('.fp-head--sm .fp-head__title')).toContain('calc(var(--text-display) * 11 / 7)');
  });
});

describe('5. form card', () => {
  it('renders the note under the form', async () => {
    const { container } = view('form', { formId: 'form:abc', heading: 'Tell us', layout: 'card', note: 'Read by a person.' });
    await screen.findByTestId('form');
    expect(container.querySelector('.fp-formcard__card > .fp-formcard__note')?.textContent).toBe('Read by a person.');
  });

  it('sets the 576px card column, the design fields and the first-pair rule', () => {
    expect(css).toContain('.fp-formcard__inner { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 576px);');
    expect(css).toMatch(/\.fp-formcard__card \.form-card :is\(input[^{]*\{ min-height: 50px; border: 1\.5px solid var\(--rule-control\); border-radius: var\(--space-3\);/);
    expect(css).toMatch(/\.fp-formcard__card \.form-card :is\(input[^{]*\):focus-visible \{ outline: none; border-color: var\(--clay-strong\); box-shadow: 0 0 0 4px color-mix\(in srgb, var\(--clay-strong\) 16%, transparent\); \}/);
    expect(css).toContain('.form-card > .form-card__short ~ .form-card__short ~ .form-card__short { grid-column: 1 / -1; }');
  });
});

describe('6. split FAQ picture (security)', () => {
  it('keeps the picture under the heading in the first column; questions in the second, both rows', () => {
    const { container } = view('faq', { heading: 'Questions', head: 'split', imageToken: 'tok_shot', alt: 'A screenshot', items: [{ q: 'Is it safe?', a: 'Yes.' }] });
    const kids = Array.from(container.querySelector('.fp-shell')!.children).map((n) => n.className.split(' ')[0]);
    expect(kids).toEqual(['fp-head', 'fp-faq__shot', 'fp-faq']);
    const at = css.indexOf('.fp-faq-section.fp-split .fp-shell > .fp-faq { grid-column: 2; grid-row: 1 / span 2; }');
    expect(at).toBeGreaterThan(0);
    expect(openMediaAt(at)).toBe('@media (min-width: 900px)');
    expect(css).toContain('.fp-faq-section.fp-split .fp-shell > .fp-head, .fp-faq-section.fp-split .fp-shell > .fp-faq__shot { grid-column: 1; }');
  });
});

