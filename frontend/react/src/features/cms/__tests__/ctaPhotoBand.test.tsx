/**
 * #6150 — a `cta` band with a photo behind it and the hero's queue card beside the
 * copy, and picture-only cards in a `marquee` strip. Asked for by a white-label
 * adopter (CasaVoga), whose local edit these tests were ported from.
 * Guards:
 * - the photo is drawn with its alt text, and the band carries the photo class;
 * - the queue card shows its title and every row, and the band carries the queue class;
 * - a plain cta gains no picture, no card and neither class;
 * - a marquee item with only a picture (and its alt text) is a card in the strip;
 *   an item with neither words nor a picture is still left out.
 *
 * Sabotage: dropping `fp-cta--photo` or the `<img>` reds the first case; dropping
 * the `<HeroQueue>` reds the second; restoring the marquee filter to `title || text`
 * reds the picture-only case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(() => { cleanup(); });

function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}

describe('a cta band with a photo and a queue card', () => {
  const base = { heading: 'Three selections hold the rough-in.', subheading: 'In date order.', label: 'Run the simulator', url: '/p/simulator' };
  const queue = { title: 'Before the walls close', label: 'Sample project', rows: [
    { id: 'PLB-018', title: 'Primary shower valve and trim', meta: 'Decide by Feb 19', status: 'No owner', tone: 'bad' },
    { id: 'PLB-022', title: 'Freestanding tub filler location', status: 'Decision due', tone: 'warn' },
  ] };

  it('draws the photo with its alt text', () => {
    const { container } = view('cta', { ...base, imageToken: 'tok-k', alt: 'A white kitchen' });
    const img = container.querySelector('img.fp-cta__photo');
    expect(img?.getAttribute('alt')).toBe('A white kitchen');
    expect(img?.getAttribute('src')).toContain('tok-k');
    expect(container.querySelector('.fp-cta')!.classList.contains('fp-cta--photo')).toBe(true);
    expect(container.querySelector('.fp-queue')).toBeNull();
  });

  it('shows the queue card with every row, after the copy and the button', () => {
    const { container } = view('cta', { ...base, imageToken: 'tok-k', alt: 'A white kitchen', queue });
    const band = container.querySelector('.fp-cta') as HTMLElement;
    expect(band.classList.contains('fp-cta--queue')).toBe(true);
    const card = within(band).getByRole('figure', { name: 'Before the walls close' });
    expect(within(card).getAllByRole('listitem').length).toBe(2);
    expect(within(card).getByText('Primary shower valve and trim')).toBeTruthy();
    expect(within(card).getByText('No owner')).toBeTruthy();
    // Inside the band's inner box, after the actions.
    expect(card.parentElement!.classList.contains('fp-cta__inner')).toBe(true);
    expect(card.previousElementSibling!.classList.contains('fp-cta__actions')).toBe(true);
    expect(screen.getByRole('link', { name: 'Run the simulator' }).getAttribute('href')).toBe('/p/simulator');
  });

  it('leaves a plain cta as it was', () => {
    const { container } = view('cta', base);
    const band = container.querySelector('.fp-cta') as HTMLElement;
    expect(band.classList.contains('fp-cta--photo')).toBe(false);
    expect(band.classList.contains('fp-cta--queue')).toBe(false);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.fp-queue')).toBeNull();
  });
});

describe('picture-only cards in a marquee strip', () => {
  it('draws a card for an item with only a picture, named by its alt text', () => {
    const { container } = view('columns', {
      layout: 'marquee',
      columns: [
        { title: 'Kitchen', imageToken: 'tok-a', alt: 'A white kitchen' },
        { imageToken: 'tok-b', alt: 'A tiled bathroom' },
        { text: '' },
      ],
    });
    // The strip and its hidden copy each hold one card per drawable item.
    const visible = container.querySelector('.fp-marquee__list:not([aria-hidden])') as HTMLElement;
    const cards = visible.querySelectorAll('.fp-marquee__item--card');
    expect(cards.length).toBe(2);
    expect(within(cards[1] as HTMLElement).getByRole('img', { name: 'A tiled bathroom' })).toBeTruthy();
  });
});
