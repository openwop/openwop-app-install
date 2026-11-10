/**
 * ADR 1063 P2b — the `video` section's `chip: "corner"` film card.
 *
 * The play control becomes a bottom-left chip carrying the film's title and
 * length; its accessible name still says what it does ("Watch the video") and names the
 * film; the title leaves the visible caption so it is not read twice, while a
 * YouTube link stays; the section's chip applies to its second film too. The
 * ripple is CSS that runs twice (under the WCAG 2.2.2 five-second bar), never
 * infinite. Without `chip` the player is unchanged.
 *
 * Red when (sabotage-witnessed, w91 g2): the corner class, the chip's title or
 * length stop rendering, the accessible name loses the action (for either
 * film) or the title, the title shows in both places, the YouTube link drops,
 * the plain caption drops, the chip stops starting the film, film2 ignores the
 * section chip, or the ripple runs three times or infinitely.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const FILM = {
  title: 'Whose agent is it?',
  length: '3:57',
  src: 'https://example.test/film.mp4',
  poster: 'https://example.test/film.jpg',
};
const videoSection = (data: Record<string, unknown>): Section => ({ sectionId: 'v', type: 'video', data });
const renderVideo = (data: Record<string, unknown>) =>
  render(<MemoryRouter><RenderSection section={videoSection(data)} mode="public" /></MemoryRouter>);

describe('video chip "corner"', () => {
  it('puts the title and length in a play chip named for the film', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { container } = renderVideo({ ...FILM, chip: 'corner', youtubeUrl: 'https://www.youtube.com/watch?v=x' });
    expect(container.querySelector('figure.fp-film--corner')).not.toBeNull();
    const button = screen.getByRole('button', { name: 'Watch the video: Whose agent is it? 3:57' });
    expect(button.querySelector('.fp-film__chip-title')?.textContent).toBe('Whose agent is it?');
    expect(button.querySelector('.fp-film__len')?.textContent).toBe('3:57');
    // The title is not repeated in the caption; the YouTube link stays.
    const cap = container.querySelector('figcaption');
    if (!(cap instanceof HTMLElement)) throw new Error('missing figcaption');
    expect(cap.querySelector('.fp-film__title')).toBeNull();
    expect(cap.textContent).not.toContain('Whose agent is it?');
    expect(cap.querySelector('a')?.getAttribute('href')).toBe('https://www.youtube.com/watch?v=x');
    fireEvent.click(button);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('applies to the second film too', () => {
    const { container } = renderVideo({ ...FILM, chip: 'corner', film2: { ...FILM, title: 'Second film', length: '1:02' } });
    expect(container.querySelectorAll('figure.fp-film--corner')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Watch the video: Second film 1:02' })).toBeTruthy();
    // Neither film repeats its title in a caption (no YouTube link, so no caption at all).
    expect(container.querySelectorAll('figcaption')).toHaveLength(0);
  });

  it('without chip, the player is unchanged', () => {
    const { container } = renderVideo(FILM);
    expect(container.querySelector('.fp-film--corner')).toBeNull();
    expect(container.querySelector('.fp-film__chip-title')).toBeNull();
    expect(container.querySelector('figcaption .fp-film__title')?.textContent).toBe('Whose agent is it?');
  });

  it('runs the ripple a bounded number of times, never infinitely', () => {
    const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
    const rule = css.match(/\.fp-film__disc::after \{ animation: fp-film-ripple 2\.2s [^;]* (\d+); \}/);
    expect(rule, 'ripple animation rule').not.toBeNull();
    expect(Number(rule?.[1]) * 2.2).toBeLessThanOrEqual(5);
    expect(css).not.toMatch(/fp-film-ripple[^;]*infinite/);
  });
});
