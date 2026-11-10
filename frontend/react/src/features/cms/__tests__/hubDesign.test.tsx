/**
 * ADR 1047 — the capabilities hero hub, redrawn to the myndhyve.ai design (2026-11-07).
 * The data was already right; the picture was not: a small pale tile with dark
 * text, no rings, one-line places, and a phone for "Your app".
 *
 * Pins what the design adds and a reader can lose:
 * - the SVG carries the dashed orbit (r 40) and the inner ring (r 22) in the
 *   same 0–100 space as the spokes, and a travelling highlight per spoke that
 *   exists only on the motion path (reduced motion shows the finished drawing);
 * - each place is a two-line card: an icon tile, then the index ABOVE the
 *   label in one text column, with the glyph at 22 / stroke 1.8;
 * - `device` draws a monitor and a phone, not a lone phone;
 * - the centre is the solid core colour with light text and a two-step halo,
 *   every hub colour comes from a --fp-hub-* token derived from page tokens
 *   (the scan refuses a hex, rgb()/rgba() or hsl()/hsla() literal in the hub
 *   rules; `white`/`black` used as shading inside color-mix() are not scanned),
 *   and the hover inverts the tile onto the core.
 *
 * Sabotage (each witnessed red): drop the orbit or ring circle; give the pulse a
 * resting `display` (or close the motion guard ahead of it); put the label before
 * the index; render `device` with the phone glyph; set the centre background
 * back to a flat --clay-text; hard-code a hex in a hub rule; drop the hover rule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
/** The declaration block of the FIRST rule whose selector is exactly `sel`. */
function rule(sel: string): string {
  const i = css.indexOf(`${sel} {`);
  if (i < 0) throw new Error(`no rule ${sel}`);
  return css.slice(i, css.indexOf('}', i) + 1);
}
/** Any `@media` prelude carrying the no-preference motion query, `screen and` or not. */
const isMotionGuard = (p: string): boolean => /^@media\b[^{]*\(prefers-reduced-motion:\s*no-preference\)/.test(p);
const hubCss = css.slice(css.indexOf('.fp-hub {'), css.indexOf('@keyframes fp-hub-place'));

const HUB = {
  center: { label: 'Your agent', imageToken: 'tok_head', alt: 'The robot head' },
  spokes: [
    { label: 'Team chat', index: '01', icon: 'chat' },
    { label: 'Customers', index: '02', icon: 'users' },
    { label: 'Your app', index: '08', icon: 'device' },
  ],
};
function hub() {
  const { container } = render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'hub', hub: HUB } }} mode="public" /></MemoryRouter>);
  const fig = container.querySelector('.fp-hub');
  if (!fig) throw new Error('no hub');
  return fig;
}

describe('hub design — the drawing', () => {
  it('draws the dashed orbit and the inner ring in the spokes’ 0–100 space', () => {
    const svg = hub().querySelector('.fp-hub__lines')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
    const orbit = svg.querySelector('circle.fp-hub__orbit');
    const ring = svg.querySelector('circle.fp-hub__ring');
    expect([orbit?.getAttribute('cx'), orbit?.getAttribute('cy'), orbit?.getAttribute('r')]).toEqual(['50', '50', '40']);
    expect([ring?.getAttribute('cx'), ring?.getAttribute('cy'), ring?.getAttribute('r')]).toEqual(['50', '50', '22']);
    expect(rule('.fp-hub__orbit')).toContain('stroke-dasharray: 1.2 1.6');
  });

  it('gives each spoke a highlight that exists only on the motion path', () => {
    const fig = hub();
    const pulses = fig.querySelectorAll('.fp-hub__pulse');
    expect(pulses).toHaveLength(fig.querySelectorAll('.fp-hub__spoke').length);
    expect(rule('.fp-hub__pulse')).toContain('display: none');
    const shown = css.indexOf('.fp-hub__pulse { display: inline;');
    expect(shown).toBeGreaterThan(0);
    const guard = css.slice(css.lastIndexOf('@media', shown), shown);
    expect(isMotionGuard(guard.trimStart()), 'the nearest @media is the no-preference motion guard').toBe(true);
    // …and that block is still OPEN at the rule, not closed ahead of it.
    const depth = [...guard].reduce((d, ch) => d + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
    expect(depth).toBe(1);
  });
});

describe('hub design — the places', () => {
  it('is a two-line card: the icon tile, then the index above the label', () => {
    const place = hub().querySelector('.fp-hub__place')!;
    const kids = Array.from(place.children).map((c) => c.className);
    expect(kids).toEqual(['fp-hub__icon', 'fp-hub__text']);
    const text = Array.from(place.querySelector('.fp-hub__text')!.children).map((c) => [c.className, c.textContent]);
    expect(text).toEqual([['fp-hub__index', '01'], ['fp-hub__name', 'Team chat']]);
    const glyph = place.querySelector('.fp-hub__icon svg')!;
    expect([glyph.getAttribute('width'), glyph.getAttribute('stroke-width')]).toEqual(['22', '1.8']);
  });

  it('draws "Your app" as a monitor and a phone', () => {
    const svg = hub().querySelectorAll('.fp-hub__place')[2]!.querySelector('svg')!;
    const rects = Array.from(svg.querySelectorAll('rect')).map((r) => ['x', 'y', 'width', 'height'].map((a) => r.getAttribute(a)));
    expect(rects).toEqual([['2.5', '5', '13', '10'], ['16.5', '8', '5', '11']]);
    expect(svg.querySelector('path')?.getAttribute('d')).toBe('M6 19h6M9 15v4');
  });

  it('inverts the tile onto the core on hover', () => {
    expect(rule('.fp-hub__place:hover .fp-hub__icon')).toContain('background: var(--fp-hub-core); color: var(--fp-hub-on-core);');
  });
});

describe('hub design — the centre and the colours', () => {
  it('is the solid core with light text and a two-step halo', () => {
    const c = rule('.fp-hub__center');
    expect(c).toMatch(/background: linear-gradient\(160deg, [^;]*var\(--fp-hub-core\) 55%/);
    expect(c).toContain('color: var(--fp-hub-on-core)');
    expect(c).toContain('0 0 0 10px color-mix(in srgb, var(--fp-hub-core) 16%, transparent), 0 0 0 22px color-mix(in srgb, var(--fp-hub-core) 7%, transparent)');
  });

  it('takes every colour from a --fp-hub-* token derived from page tokens', () => {
    expect(hubCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const root = rule('.fp-hub');
    for (const [tok, from] of [['core', 'clay-strong'], ['line', 'rule'], ['accent', 'clay-text'], ['card', 'paper'], ['on-core', 'tone-inverse-ink']]) {
      expect(root).toContain(`--fp-hub-${tok}: var(--${from});`);
    }
  });
});
