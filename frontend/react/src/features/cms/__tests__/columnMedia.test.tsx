/**
 * ADR 1037 — column media as a visitor and an editor meet it.
 * Guards:
 * - a bento tile with `imageToken` shows its picture (with its alt text, lazy)
 *   as the tile's LAST element, inside the ADR 1032 browser frame when it names
 *   an address;
 * - a bento tile with `href` is ONE link; `highlight` adds the highlight class;
 *   a plain tile keeps its exact class and has no picture;
 * - a marquee whose items carry pictures renders app cards (picture + name +
 *   line), the readable copy first and an inert, hidden duplicate for the loop;
 *   without pictures it is the bare-name marquee exactly as before;
 * - the editor offers the picture, alt, address and highlight fields on a bento
 *   tile (each bound to the item's value), and highlight without a picture on a
 *   list column.
 * The `list` layout's `highlight` class is covered by
 * `SectionRenderer.columnsList.test.tsx` › "marks a `partial` column": the same
 * sabotage reddened both files in w92, so the duplicate case here was cut.
 *
 * Ceiling: the drift and the outline are CSS; jsdom sees the markup and hooks.
 * Sabotage-witnessed (w92, /grade-tests): an unframed ColumnShot, eager
 * loading, an element after the shot, the internal-link branch dropped, the
 * highlight class dropped or always on, the marquee always in card mode, the
 * copy list without `inert`, and each editor field gate or the alt field
 * removed each turn a case here red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}
const APPS = [
  { title: 'Acme', text: 'A goals app.', imageToken: 'tok_kt', alt: 'Acme home page', frameUrl: 'acme.example' },
  { title: 'Book AI', text: 'A writing studio.', imageToken: 'tok_ba', alt: 'Book AI home page' },
];

describe('ADR 1037 — bento media', () => {
  it('shows a framed picture at the tile foot, with its alt text', () => {
    const { container } = view('columns', { layout: 'bento', columns: [{ title: 'Start with an agent', text: 'Pick a role.', imageToken: 'tok_a', alt: 'The role picker', frameUrl: 'myndhyve.ai/agents' }] });
    const shot = container.querySelector('.fp-bento__tile .fp-bento__shot') as HTMLElement;
    expect(shot.classList.contains('fp-browser')).toBe(true);
    expect(shot.querySelector('.fp-browser__bar')?.getAttribute('aria-hidden')).toBe('true');
    const img = within(shot).getByRole('img', { name: 'The role picker' });
    expect(img.getAttribute('loading')).toBe('lazy');
    // At the tile's foot: the shot is the tile's last element.
    expect(container.querySelector('.fp-bento__tile')?.lastElementChild).toBe(shot);
  });
  it('makes a linked tile one link, and marks a highlighted tile', () => {
    const { container } = view('columns', { layout: 'bento', columns: [{ title: 'See what is built', text: 'All of it.', href: '/p/templates', highlight: true }] });
    const link = screen.getByRole('link', { name: /See what is built/ });
    expect(link.classList.contains('fp-bento__tile')).toBe(true);
    expect(link.classList.contains('fp-bento__tile--highlight')).toBe(true);
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });
  it('keeps a plain tile exactly as before', () => {
    const { container } = view('columns', { layout: 'bento', columns: [{ title: 'A', text: 'B' }] });
    const tile = container.querySelector('.fp-bento__tile') as HTMLElement;
    expect(tile.tagName).toBe('ARTICLE');
    expect(tile.className).toBe('fp-card fp-bento__tile');
    expect(tile.querySelector('img')).toBeNull();
  });
});

describe('ADR 1037 — marquee app cards', () => {
  it('renders app cards, readable first and an inert hidden copy', () => {
    const { container } = view('columns', { layout: 'marquee', columns: APPS });
    const lists = container.querySelectorAll('.fp-marquee__list');
    expect(lists).toHaveLength(2);
    const real = lists[0] as HTMLElement;
    expect(real.getAttribute('aria-hidden')).toBeNull();
    expect(real.querySelectorAll('.fp-marquee__card')).toHaveLength(2);
    expect(within(real).getByRole('img', { name: 'Acme home page' })).toBeTruthy();
    expect(within(real).getByText('A writing studio.')).toBeTruthy();
    expect(real.querySelector('.fp-browser__url')?.textContent).toBe('acme.example');
    const copy = lists[1] as HTMLElement;
    expect(copy.getAttribute('aria-hidden')).toBe('true');
    expect(copy.hasAttribute('inert')).toBe(true);
  });
  it('keeps the bare-name marquee without pictures', () => {
    const { container } = view('columns', { layout: 'marquee', columns: [{ title: 'HubSpot', text: '' }, { title: 'Stripe', text: '' }] });
    expect(container.querySelector('.fp-marquee__card')).toBeNull();
    expect([...container.querySelectorAll('.fp-marquee__list')[0]!.querySelectorAll('.fp-marquee__item')].map((li) => li.textContent)).toEqual(['HubSpot', 'Stripe']);
  });
});

describe('ADR 1037 — the editor', () => {
  const noop = (): void => undefined;
  it('offers picture, alt, address and highlight on a bento tile', () => {
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'columns', data: { layout: 'bento', columns: [{ title: 'A', text: 'B', imageToken: 'tok_a', alt: 'X' }] } }} onChange={noop} assets={[]} /></MemoryRouter>);
    expect((screen.getByLabelText(/Picture \(tile foot or app card\)/) as HTMLInputElement).value).toBe('tok_a');
    expect((screen.getByLabelText('Alt text') as HTMLInputElement).value).toBe('X');
    expect((screen.getByLabelText('Address shown in the window bar') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('checkbox', { name: /Highlight this item/ }) as HTMLInputElement).checked).toBe(false);
  });
  it('offers highlight but no picture on a list column', () => {
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'columns', data: { layout: 'list', columns: [{ title: 'A', text: 'B' }] } }} onChange={noop} assets={[]} /></MemoryRouter>);
    expect(screen.getByRole('checkbox', { name: /Highlight this item/ })).toBeTruthy();
    expect(screen.queryByText(/Picture \(tile foot or app card\)/)).toBeNull();
  });
});
