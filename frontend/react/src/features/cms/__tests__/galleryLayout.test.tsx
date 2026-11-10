/**
 * ADR 1063 P2e — the `gallery` columns layout.
 *
 * Each column with a picture becomes a figure: the screenshot (browser-framed
 * when the column has a `frameUrl`) and a caption from its title and text. A
 * column with no picture is skipped, because a gallery item is its picture.
 * `highlight` makes a proof card. A gallery of one spans the row.
 *
 * Red when: a picture-less column renders an empty figure, the alt text or the
 * frame drops, the caption stops rendering title + text, the proof class drops,
 * or a single shot stops spanning the row.
 * Sabotage-witnessed (w92, /grade-tests): rendering every column, dropping the
 * proof class, the caption title or text, the alt or the frameUrl, and moving
 * the `--one` boundary either way (0 or >= 1) each turn a case here red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const gallery = (columns: Array<Record<string, unknown>>): HTMLElement => {
  const section: Section = { sectionId: 'sec:shots', type: 'columns', data: { heading: 'See it', layout: 'gallery', columns } };
  return render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>).container;
};

describe('gallery layout', () => {
  it('renders each picture as a captioned figure, framed when it has a frameUrl', () => {
    const c = gallery([
      { title: 'Workflow builder', text: 'Draw the steps.', imageToken: 'med_a', alt: 'The workflow builder canvas', frameUrl: 'app.example/builder' },
      { title: 'Agents · Riley', text: 'One agent, its tools.', imageToken: 'med_b', alt: 'Riley agent settings' },
      { title: 'No picture', text: 'Skipped.' },
    ]);
    const figs = [...c.querySelectorAll('.fp-gallery__grid > figure.fp-gallery__item')] as HTMLElement[];
    expect(figs).toHaveLength(2);
    expect(figs[0]!.querySelector('img')?.getAttribute('alt')).toBe('The workflow builder canvas');
    expect(figs[0]!.querySelector('.fp-browser .fp-browser__url')?.textContent).toBe('app.example/builder');
    expect(figs[1]!.querySelector('.fp-browser')).toBeNull();
    const cap = figs[0]!.querySelector('figcaption')!;
    expect(cap.querySelector('.fp-gallery__title')?.textContent).toBe('Workflow builder');
    expect(cap.querySelector('.fp-gallery__text')?.textContent).toBe('Draw the steps.');
    expect(c.querySelector('.fp-gallery__grid--one')).toBeNull();
  });

  it('marks a proof card and lets one shot span the row', () => {
    const c = gallery([{ title: 'Approval · waiting for you', imageToken: 'med_c', alt: 'An approval step waiting', highlight: true }]);
    expect(c.querySelector('.fp-gallery__grid')?.classList.contains('fp-gallery__grid--one')).toBe(true);
    expect(c.querySelector('figure')?.classList.contains('fp-gallery__item--proof')).toBe(true);
  });
});
