/**
 * ADR 1150 — the `split` column layout (D1: a photo beside its text, sides
 * alternating, an optional per-row link), gallery tiles that link (D2), and the
 * `video` hero (D3: muted, looping, decorative, with a Pause / Play button, and
 * no autoplay under reduced motion). First proposed by a white-label adopter.
 * Guards:
 * - each split row is a list item; every second row carries the flip class so
 *   its photo sits on the right;
 * - a row's link is a real anchor to its ctaUrl, labelled with its ctaLabel,
 *   and a row without both fields shows no link;
 * - a gallery tile with an href is a link around its picture; one without an
 *   href is not;
 * - the editor offering `split` is pinned by adr1029-mirror-parity.
 * - the video hero plays on its own, can be paused, and never starts under
 *   reduced motion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.removeAttribute('data-reduce-motion'); });

function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}

describe('the split layout', () => {
  const cols = [
    { title: 'First', text: 'Alpha', ctaLabel: 'Go one', ctaUrl: '/p/one', imageToken: 'tok-1', alt: 'A kitchen' },
    { title: 'Second', text: 'Beta', imageToken: 'tok-2', alt: 'A bath' },
    { title: 'Third', text: 'Gamma', ctaLabel: 'Go three', ctaUrl: '/p/three', imageToken: 'tok-3', alt: 'A hall' },
  ];

  it('renders one list item per row, in order', () => {
    const { container } = view('columns', { layout: 'split', heading: 'H', columns: cols });
    const rows = container.querySelectorAll('.fp-split__row');
    expect(rows.length).toBe(3);
    expect(within(rows[0] as HTMLElement).getByRole('heading', { name: 'First' })).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByRole('heading', { name: 'Third' })).toBeTruthy();
  });

  it('flips every second row so its photo sits on the right', () => {
    const { container } = view('columns', { layout: 'split', heading: 'H', columns: cols });
    const rows = Array.from(container.querySelectorAll('.fp-split__row'));
    expect(rows[0]!.classList.contains('fp-split__row--flip')).toBe(false);
    expect(rows[1]!.classList.contains('fp-split__row--flip')).toBe(true);
    expect(rows[2]!.classList.contains('fp-split__row--flip')).toBe(false);
  });

  it('links a row only when it has both a label and a URL', () => {
    view('columns', { layout: 'split', heading: 'H', columns: cols });
    const one = screen.getByRole('link', { name: 'Go one' });
    expect(one.getAttribute('href')).toBe('/p/one');
    expect(screen.getByRole('link', { name: 'Go three' }).getAttribute('href')).toBe('/p/three');
    // The middle row has no ctaLabel, so it shows no link at all.
    expect(screen.getAllByRole('link').length).toBe(2);
  });
});

describe('gallery tiles that link', () => {
  const tiles = [
    { title: 'Linked', imageToken: 'tok-a', alt: 'A library', href: '/p/every-decision' },
    { title: 'Plain', imageToken: 'tok-b', alt: 'A table' },
  ];

  it('wraps a tile that has an href in a link to it', () => {
    view('columns', { layout: 'gallery', heading: 'H', columns: tiles });
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/p/every-decision');
    expect(link.classList.contains('fp-gallery__link')).toBe(true);
  });

  it('renders no link for an unsafe href that bypassed the validator', () => {
    // An allowlist, not a scheme blocklist: browsers strip tab/newline/CR from a URL
    // (`java\tscript:` runs as javascript:) and read `/\` as `//` (off-origin).
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', '//evil.example.test/x', 'java\tscript:alert(1)', 'java\nscript:alert(1)', '/\\evil.example', ' \u0001javascript:alert(1)']) {
      const { container, unmount } = view('columns', { layout: 'gallery', heading: 'H', columns: [{ title: 'Bad', imageToken: 'tok-x', alt: 'x', href }] });
      expect(container.querySelector('a'), href).toBeNull();
      unmount();
    }
  });

  it('leaves a tile without an href unlinked', () => {
    const { container } = view('columns', { layout: 'gallery', heading: 'H', columns: [tiles[1]] });
    expect(container.querySelector('.fp-gallery__link')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the video hero', () => {
  const hero = { heading: 'Rooms that hold a life', visual: 'video', videoSrc: '/media/reel.mp4', posterSrc: '/media/reel.jpg' };

  it('plays a muted, looping, decorative film, and its button pauses it', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const { container } = view('hero', hero);
    const video = container.querySelector('video.fp-hero__video') as HTMLVideoElement;
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.getAttribute('aria-hidden')).toBe('true');
    expect(video.getAttribute('poster')).toBe(hero.posterSrc);
    await waitFor(() => expect(play).toHaveBeenCalled());
    const button = await screen.findByRole('button', { name: /pause/i });
    fireEvent.click(button);
    expect(pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /play/i })).toBeTruthy();
  });

  it('does not start on its own under reduced motion; the poster shows and the button offers Play', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    document.documentElement.setAttribute('data-reduce-motion', 'reduce');
    view('hero', hero);
    expect(screen.getByRole('button', { name: /play/i })).toBeTruthy();
    expect(play).not.toHaveBeenCalled();
  });

  it('renders no film for an off-origin source that bypassed the validator', () => {
    for (const videoSrc of ['https://cdn.example.test/loop.mp4', '//cdn.example.test/loop.mp4', '/\\cdn.example.test/loop.mp4', '/media/re\tel.mp4']) {
      const { container, unmount } = view('hero', { ...hero, videoSrc });
      expect(container.querySelector('video'), videoSrc).toBeNull();
      unmount();
    }
  });

  it('a refused autoplay leaves the button on Play, never a false Pause', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('NotAllowedError'));
    view('hero', hero);
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /play/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
  });
});
