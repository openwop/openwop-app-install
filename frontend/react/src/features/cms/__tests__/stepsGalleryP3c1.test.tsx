/**
 * ADR 1072 — design batch Phase 3c1: step cards, the lead gallery, a gallery of
 * four, and the browser figure's caption.
 *
 *   - D1: `cards: true` boxes each step with a "01" chip (even when the section
 *     asked for circle numbers) and makes a `highlight` step the dark card; a
 *     steps section without it is unchanged.
 *   - D2: `galleryLayout: 'lead'` marks a gallery of two or more; a gallery of
 *     exactly four goes four across on a wide screen.
 *   - D3: a browser figure's caption reads from the start.
 *
 * Sabotage witnesses (w96 probes): dropping the cards class, keeping circle
 * numbers in cards, chips outside cards, dropping the highlight's band tokens,
 * highlighting every card or leaking the highlight outside cards, marking a
 * one-picture gallery as lead, requiring three pictures for a lead, dropping
 * the lead mark, or losing the four-across or caption rules reds a case.
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
const steps = [{ title: 'Tell us', text: 'a' }, { title: 'We build', text: 'b', highlight: true }, { title: 'You launch', text: 'c' }];
const shot = (n: number) => ({ title: `Shot ${n}`, imageToken: `tok-${n}`, alt: `Picture ${n}` });

describe('step cards (ADR 1072 D1)', () => {
  it('boxes each step with a two-digit chip and darkens the highlighted one', () => {
    const c = renderSection({ sectionId: 'sec:next', type: 'columns', data: { layout: 'steps', cards: true, numbers: 'circle', columns: steps } });
    const s = c.querySelector('section')!;
    expect(s.classList.contains('fp-steps--cards')).toBe(true);
    expect(s.classList.contains('fp-steps--circle'), 'cards draw chips, not circles').toBe(false);
    expect([...c.querySelectorAll('.fp-step__num')].map((n) => n.textContent)).toEqual(['01', '02', '03']);
    const [, mid, last] = [...c.querySelectorAll('.fp-step')];
    expect(mid!.classList.contains('fp-step--highlight') && mid!.classList.contains('fp-tone--inverse')).toBe(true);
    expect(last!.classList.contains('fp-step--highlight')).toBe(false);
  });

  it('leaves steps without cards exactly as they were', () => {
    const c = renderSection({ sectionId: 'sec:next', type: 'columns', data: { layout: 'steps', numbers: 'circle', columns: steps } });
    expect(c.querySelector('section')!.classList.contains('fp-steps--circle')).toBe(true);
    expect(c.querySelector('.fp-step--highlight'), 'no highlight outside cards').toBeNull();
    expect([...c.querySelectorAll('.fp-step__num')].map((n) => n.textContent)).toEqual(['1', '2', '3']);
  });
});

describe('gallery arrangements (ADR 1072 D2) and the figure caption (D3)', () => {
  it('marks a lead gallery of two or more, never one picture', () => {
    // Exactly two: the boundary of "two or more" (three would pass a `> 2` slip).
    const lead = renderSection({ sectionId: 'sec:canvas', type: 'columns', data: { layout: 'gallery', galleryLayout: 'lead', columns: [shot(1), shot(2)] } });
    expect(lead.querySelector('.fp-gallery__grid')!.classList.contains('fp-gallery__grid--lead')).toBe(true);
    cleanup();
    const one = renderSection({ sectionId: 'sec:one', type: 'columns', data: { layout: 'gallery', galleryLayout: 'lead', columns: [shot(1)] } });
    expect(one.querySelector('.fp-gallery__grid')!.classList.contains('fp-gallery__grid--lead')).toBe(false);
  });

  it('lays four pictures four across, and starts a browser caption at the start', () => {
    expect(css).toMatch(/@media \(min-width: 1024px\) \{ \.fp-gallery__grid:not\(\.fp-gallery__grid--lead\):has\(> :nth-child\(4\):last-child\) \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \} \}/);
    expect(css).toContain('.fp-figure--browser .fp-figure__cap { text-align: start; }');
  });
});
