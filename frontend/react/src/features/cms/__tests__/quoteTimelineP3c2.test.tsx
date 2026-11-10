/**
 * ADR 1073 — design batch Phase 3c2: the richText pull quote and two timeline
 * options.
 *
 *   - D1: a richText `quote` sits under the heading as a blockquote, with the
 *     head, in the lead column; without one the section is unchanged.
 *   - D2: a timeline's `shotSide: 'start'` puts the head and the picture in one
 *     start-side column (picture before the list in reading order).
 *   - D3: `markers: 'badge'` draws a numbered badge per item instead of a dot;
 *     the highlighted item's badge is the live one.
 *
 * Sabotage witnesses: dropping the quote or putting it after the essay, losing
 * the lead's gap (the split head zeroes the heading's margin),
 * leaving the head on top with start side, drawing dots with badges, or
 * losing the live mark reds a case.
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
const items = [{ title: 'KickTodo', text: 'a' }, { title: 'Book AI', text: 'b' }, { title: 'MyndHyve', text: 'c', highlight: true }];

describe('pull quote (ADR 1073 D1)', () => {
  it('puts the quote under the heading, before the essay', () => {
    const c = renderSection({ sectionId: 'sec:belief', type: 'richText', data: { heading: 'The one-person company', quote: 'Small teams are doing work that used to need departments.', text: 'The essay.', head: 'split' } });
    const lead = c.querySelector('.fp-prose__lead')!;
    expect(lead.querySelector('h2')?.textContent).toBe('The one-person company');
    expect(lead.querySelector('blockquote.fp-prose__quote')?.textContent).toBe('Small teams are doing work that used to need departments.');
    expect(lead.compareDocumentPosition(c.querySelector('.fp-prose__body')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The split head zeroes .fp-head's margin (.fp-prose.fp-split .fp-head), so
    // the quote's distance from the heading is the lead's own gap.
    expect(css).toMatch(/\.fp-prose__lead \{ display: grid; gap: var\(--space-5\);/);
  });

  it('leaves a section without a quote unchanged', () => {
    const c = renderSection({ sectionId: 'sec:plain', type: 'richText', data: { heading: 'Plain', text: 'x' } });
    expect(c.querySelector('.fp-prose__lead')).toBeNull();
    expect(c.querySelector('blockquote')).toBeNull();
  });
});

describe('timeline options (ADR 1073 D2/D3)', () => {
  it('puts the head and the picture on the start side, the picture before the list', () => {
    const c = renderSection({ sectionId: 'sec:built', type: 'columns', data: { layout: 'timeline', heading: 'What is built', shotSide: 'start', imageToken: 'tok-1', alt: 'Apps', columns: items } });
    expect(c.querySelector('section')!.classList.contains('fp-timeline--start')).toBe(true);
    const aside = c.querySelector('.fp-timeline__aside')!;
    expect(aside.querySelector('h2')?.textContent).toBe('What is built');
    expect(c.querySelectorAll('h2'), 'the head moves, it is not repeated').toHaveLength(1);
    expect(aside.querySelector('.fp-timeline__shot img')).not.toBeNull();
    expect(c.querySelectorAll('.fp-timeline__shot'), 'one picture, not two').toHaveLength(1);
    expect(aside.compareDocumentPosition(c.querySelector('.fp-timeline__list')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws numbered badges, the highlighted one live', () => {
    const c = renderSection({ sectionId: 'sec:built', type: 'columns', data: { layout: 'timeline', markers: 'badge', columns: items } });
    expect([...c.querySelectorAll('.fp-timeline__badge')].map((b) => b.textContent)).toEqual(['01', '02', '03']);
    expect(c.querySelector('.fp-timeline__dot')).toBeNull();
    const last = c.querySelectorAll('.fp-timeline__item')[2]!;
    expect(last.classList.contains('fp-timeline__item--live')).toBe(true);
    expect(c.querySelectorAll('.fp-timeline__item--live')).toHaveLength(1);
  });

  it('keeps dots and the head on top without the options', () => {
    const c = renderSection({ sectionId: 'sec:built', type: 'columns', data: { layout: 'timeline', heading: 'Built', columns: items } });
    expect(c.querySelectorAll('.fp-timeline__dot')).toHaveLength(3);
    expect(c.querySelector('.fp-timeline__aside')).toBeNull();
    expect(c.querySelector('.fp-timeline__item--live'), 'highlight draws nothing without badges').toBeNull();
  });
});
