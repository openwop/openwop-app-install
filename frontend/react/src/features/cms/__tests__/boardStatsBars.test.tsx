/**
 * ADR 1063 P2d — the `board` columns layout and the stats progress bars.
 *
 * Board: one lane per column. Its status comes from the same flags as a
 * status list (`future`, `partial`, none = works), and is shown by a dot
 * beside the lane title, never by colour alone: the title says it. The lane's
 * count is the number of labelled items, and items render as cards with `meta`
 * as a small note. Stats: a figure with `progress` gets a bar under its label,
 * marked with the same status; a figure without one renders as before.
 *
 * Red when (sabotage-witnessed, w91 g2): a lane takes the wrong status
 * (partial or future dropped), the lane title or its decorative dot's
 * aria-hidden drops, the count stops matching the labelled items, an
 * unlabelled item renders, the note drops, a stat's status ignores its flags or
 * its progress, a bar renders without progress, the bar's width is wrong, the
 * bar moves above the label, or a plain stats band changes shape.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const renderSection = (section: Section): HTMLElement =>
  render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>).container;

/** Every HTMLElement matching `sel`, narrowed without a cast. */
const elems = (root: ParentNode, sel: string): HTMLElement[] =>
  [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

describe('board layout', () => {
  const board: Section = {
    sectionId: 'sec:mh-roadmap-stages', type: 'columns',
    data: {
      heading: 'Works today, partly there, not yet',
      layout: 'board',
      columns: [
        { title: 'Works today', items: [{ label: 'Agents that hand work to each other' }, { label: 'Campaign Studio drafts', meta: 'Early build' }] },
        { title: 'Partly there', partial: true, items: [{ label: 'About 22 connections', meta: 'Some newer than others' }, { label: '' }] },
        { title: 'Not yet', future: true, items: [{ label: 'An outside security audit' }] },
      ],
    },
  };

  it('renders a lane per column with its status, title and item count', () => {
    const c = renderSection(board);
    const lanes = elems(c, '.fp-board__lanes > .fp-lane');
    expect(lanes).toHaveLength(3);
    expect(lanes.map((l) => l.className)).toEqual(['fp-lane fp-lane--works', 'fp-lane fp-lane--partial', 'fp-lane fp-lane--future']);
    expect(lanes.map((l) => l.querySelector('h3')?.textContent)).toEqual(['Works today2', 'Partly there1', 'Not yet1']);
    // The dot is decoration; the title carries the status in words.
    expect(lanes[0]?.querySelector('.fp-lane__dot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders labelled items as cards with their note', () => {
    const c = renderSection(board);
    const partly = elems(c, '.fp-lane')[1];
    if (!partly) throw new Error('missing the second lane');
    const items = elems(partly, 'li.fp-lane__item');
    expect(items).toHaveLength(1);
    expect(items[0]?.querySelector('.fp-lane__note')?.textContent).toBe('Some newer than others');
    expect(items[0]?.firstChild?.textContent).toBe('About 22 connections');
  });
});

describe('stats progress bars', () => {
  it('adds a status-marked bar only to figures with progress', () => {
    const c = renderSection({
      sectionId: 'sec:tally', type: 'columns',
      data: {
        layout: 'stats',
        columns: [
          { title: '11', text: 'Works today', progress: 1 },
          { title: '4', text: 'Partly there', progress: 0.36, partial: true },
          { title: '5', text: 'Not yet', progress: 0.45, future: true },
          { title: '130', text: 'Features' },
        ],
      },
    });
    const stats = elems(c, '.fp-stat');
    expect(stats.map((s) => s.className)).toEqual(['fp-stat fp-stat--works', 'fp-stat fp-stat--partial', 'fp-stat fp-stat--future', 'fp-stat']);
    const [, partly, , plain] = stats;
    if (!partly || !plain) throw new Error('missing stats');
    // The bar sits under the label, at the figure's progress.
    expect([...partly.children].map((e) => e.className)).toEqual(['fp-stat__value', 'fp-stat__label', 'fp-stat__bar']);
    const fill = partly.querySelector('.fp-progress__fill');
    if (!(fill instanceof HTMLElement)) throw new Error('missing the progress fill');
    expect(fill.style.inlineSize).toBe('36%');
    expect(plain.querySelector('.fp-stat__bar')).toBeNull();
    // A figure without progress keeps the original dt + dd shape.
    expect([...plain.children].map((e) => e.tagName)).toEqual(['DT', 'DD']);
  });
});
