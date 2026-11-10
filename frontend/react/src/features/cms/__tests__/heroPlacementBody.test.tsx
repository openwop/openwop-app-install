/**
 * ADR 1066 D1/D2 — the hero picture's `placement` and the hero's `body`.
 *
 * `placement: 'below'` marks the section `fp-hero--below`; on the flow visual it
 * also runs the steps in one row (the columns `flow` row) on the band itself
 * (`fp-flow--open`, no card). The under-the-copy grid rule is one class more
 * specific than a plain `.fp-hero__grid` rule, so a brand stylesheet's generic
 * two-column hero grid cannot pull the picture back beside the copy (the
 * myndhyve.ai compare and roadmap heroes, where it did). `body` renders as a
 * second paragraph under the lede.
 *
 * Sabotage witnesses (re-measured, /grade-tests wave 95): dropping the
 * `fp-hero--below` class (or setting it on a hero with no placement), the row
 * class or the open class, rendering `body` before the lede, always, as raw
 * markdown or not at all, lowering the grid selector to
 * `.fp-hero--below .fp-hero__grid`, or giving the open flow a card reds a case.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
const flow = { nodes: [{ label: 'Something kicks it off' }, { label: 'Agents split the work' }, { label: 'It stops where you said' }], numbered: true };

describe('hero placement (ADR 1066 D1)', () => {
  it('puts a flow under the copy as one open row', () => {
    const c = renderSection({ sectionId: 'sec:how', type: 'hero', data: { heading: 'Start with one agent', visual: 'flow', placement: 'below', flow } });
    expect(c.querySelector('section.fp-hero')!.classList.contains('fp-hero--below')).toBe(true);
    const fig = c.querySelector('figure.fp-flow--hero')!;
    expect(fig.classList.contains('fp-flow--open'), 'no card under the copy').toBe(true);
    expect(fig.querySelector('.fp-flow__rail')!.classList.contains('fp-flow--row')).toBe(true);
    expect(fig.querySelectorAll('.fp-flow__step')).toHaveLength(3);
  });

  it('leaves a hero that sets no placement exactly as before', () => {
    const c = renderSection({ sectionId: 'sec:how', type: 'hero', data: { heading: 'Start with one agent', visual: 'flow', flow } });
    expect(c.querySelector('section.fp-hero')!.classList.contains('fp-hero--below')).toBe(false);
    const fig = c.querySelector('figure.fp-flow--hero')!;
    expect(fig.classList.contains('fp-flow--open')).toBe(false);
    expect(fig.querySelector('.fp-flow__rail')!.classList.contains('fp-flow--row')).toBe(false);
  });

  it('marks an illustrated visual placed below', () => {
    const c = renderSection({ sectionId: 'sec:cmp', type: 'hero', data: { heading: 'Compare', visual: 'tally', placement: 'below', tally: { items: [{ value: '8', label: 'Work today' }] } } });
    const cl = c.querySelector('section.fp-hero')!.classList;
    for (const k of ['fp-hero--art', 'fp-hero--tally', 'fp-hero--below']) expect(cl.contains(k), k).toBe(true);
  });

  it('stacks under-the-copy pictures with a rule a plain hero-grid rule cannot override', () => {
    const at = css.indexOf('.fp-hero.fp-hero--below .fp-hero__grid,');
    expect(at, 'the two-class selector').toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('}', at));
    expect(block).toContain('.fp-hero.fp-hero--versus .fp-hero__grid');
    expect(block).toContain('.fp-hero.fp-hero--tally .fp-hero__grid');
    expect(block).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).toMatch(/\.fp-flow--hero\.fp-flow--open \{[^}]*border: 0;[^}]*background: none;/);
  });
});

describe('hero body (ADR 1066 D2)', () => {
  it('renders a second paragraph after the lede', () => {
    const c = renderSection({ sectionId: 'sec:price', type: 'hero', data: { heading: 'Pricing', subheading: 'One plan.', body: "We're new: **early** prices." } });
    const lede = c.querySelector('.fp-hero__lede')!;
    const body = c.querySelector('.fp-hero__body')!;
    expect(body.textContent).toBe("We're new: early prices.");
    expect(body.querySelector('strong')?.textContent).toBe('early');
    expect(lede.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders nothing without a body', () => {
    const c = renderSection({ sectionId: 'sec:price', type: 'hero', data: { heading: 'Pricing', subheading: 'One plan.' } });
    expect(c.querySelector('.fp-hero__body')).toBeNull();
  });
});
