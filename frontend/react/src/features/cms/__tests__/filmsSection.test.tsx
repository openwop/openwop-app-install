/**
 * ADR 1082 — the `films` section: N click-to-play films in a grid, each framed
 * by its `shape`, with the ADR 1064 P3b filter chips when `filter` is set.
 *
 * Pins: every film renders through the shared player (poster first, nothing
 * loads until asked, so no `src` on the <video> at rest); a 9:16 film gets the
 * portrait frame; the chips are "All" plus each distinct value in first-seen
 * order; picking one HIDES (never removes) the others and updates the polite
 * count; fewer than two distinct values ⇒ no chips; a film with a non-https src
 * renders nothing.
 *
 * Sabotage-witnessed: dropping the shape class, removing hidden cards from the
 * DOM instead of hiding them, or always drawing the chip row reds a case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const film = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  src: `https://cdn.example.test/f${n}.mp4`, poster: `https://cdn.example.test/f${n}.jpg`,
  title: `Film ${n}`, description: `What film ${n} shows.`, length: '0:3' + String(n), ...extra,
});
const renderFilms = (data: Record<string, unknown>): HTMLElement => {
  const s: Section = { sectionId: 'sec:films', type: 'films', data };
  return render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
};
const items = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('.fp-film-gallery__item')];

describe('films section (ADR 1082)', () => {
  it('renders every film through the shared player, framed by its shape, with its tags', () => {
    const c = renderFilms({ heading: 'Examples', films: [film(1, { shape: '9:16', useCase: 'Onboarding' }), film(2, { shape: '1:1' }), film(3)] });
    expect(screen.getByRole('heading', { name: 'Examples' })).toBeTruthy();
    const [a, b, d] = items(c);
    expect(a!.classList.contains('fp-film-gallery__item--9x16')).toBe(true);
    expect(b!.classList.contains('fp-film-gallery__item--1x1')).toBe(true);
    expect(d!.classList.contains('fp-film-gallery__item--16x9'), 'no shape ⇒ 16:9').toBe(true);
    // Poster first: the <video> carries the poster, and nothing loads until asked.
    const video = a!.querySelector('video')!;
    expect(video.getAttribute('poster')).toBe('https://cdn.example.test/f1.jpg');
    expect(video.getAttribute('preload')).toBe('none');
    expect([...a!.querySelectorAll('.fp-film-gallery__tags .fp-col__badge')].map((x) => x.textContent)).toEqual(['Onboarding', '9:16']);
  });

  it('filter chips: All + each use case in first-seen order; picking one hides the rest and updates the count', () => {
    const c = renderFilms({ filter: 'useCase', films: [film(1, { useCase: 'Sales' }), film(2, { useCase: 'Onboarding' }), film(3, { useCase: 'Sales' })] });
    const group = screen.getByRole('group', { name: 'Filter films' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All (3)', 'Sales', 'Onboarding']);
    expect(within(group).getByRole('button', { name: 'All (3)' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(group).getByRole('button', { name: 'Sales' }));
    expect(items(c).map((li) => li.hidden)).toEqual([false, true, false]);
    expect(items(c), 'filtered films stay in the DOM').toHaveLength(3);
    expect(screen.getByRole('status').textContent).toBe('Showing 2 of 3 films');
  });

  it('filter by shape treats an unset shape as 16:9', () => {
    renderFilms({ filter: 'shape', films: [film(1), film(2, { shape: '9:16' })] });
    expect(within(screen.getByRole('group', { name: 'Filter films' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['All (2)', '16:9', '9:16']);
  });

  it('no chips with fewer than two distinct values, or without `filter`', () => {
    renderFilms({ filter: 'useCase', films: [film(1, { useCase: 'Sales' }), film(2, { useCase: 'Sales' })] });
    expect(screen.queryByRole('group', { name: 'Filter films' })).toBeNull();
    cleanup();
    renderFilms({ films: [film(1, { useCase: 'Sales' }), film(2, { useCase: 'Onboarding' })] });
    expect(screen.queryByRole('group', { name: 'Filter films' })).toBeNull();
  });

  it('a film whose src is not https renders no player', () => {
    const c = renderFilms({ films: [film(1, { src: 'http://cdn.example.test/f1.mp4' })] });
    expect(c.querySelector('video')).toBeNull();
  });
});
