/**
 * ADR 0843 — the `video` CMS section (public render + editor fields).
 *
 * Pinned behaviours: the film is click-to-play — `preload="none"`, a poster,
 * no native controls and no `play()` until the visitor presses the play
 * button, which shows the film's length; an English captions track with a
 * CORS read; the long description is screen-reader-only and describes the
 * video; a YouTube link only when authored; a non-https source never renders
 * a player. The editor offers every field.
 *
 * Sabotage-witnessed (w17): `preload="auto"`; `controls` always on; no `play()`
 * on click; a credentialed / missing `crossOrigin`; `srcLang` ≠ en; the
 * description dropped from `aria-describedby`; a YouTube link or captions track
 * rendered when not authored; no `rel` on the YouTube link; `httpsOnly`
 * admitting http; the editor writing `length` under another key; the YouTube
 * field removed. (`load` is never called by product code — that assertion is a
 * cheap negative, not a witnessed guard; `preload="none"` is the real one.)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const DATA = {
  heading: 'Why companies run it *as their own*',
  title: 'OpenWOP for Companies',
  description: 'A narrated film, with English captions.',
  length: '1:57',
  src: 'https://openwop.dev/assets/video/openwop-companies.mp4?v=1',
  poster: 'https://openwop.dev/assets/video/openwop-companies-poster.jpg?v=1',
  captions: 'https://openwop.dev/assets/video/openwop-companies.en.vtt?v=1',
  youtubeUrl: 'https://www.youtube.com/watch?v=ABqfybP2w4k',
};
const section = (data: Record<string, unknown>): Section => ({ sectionId: 'v1', type: 'video', data });
const renderPublic = (data: Record<string, unknown>) =>
  render(<MemoryRouter><RenderSection section={section(data)} mode="public" /></MemoryRouter>);

describe('video section — public render', () => {
  it('shows the poster and a play button with the length, and loads nothing until clicked', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const { container } = renderPublic(DATA);
    const video = container.querySelector('video')!;
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.getAttribute('poster')).toBe(DATA.poster);
    expect(video.getAttribute('src')).toBe(DATA.src);
    expect(video.hasAttribute('controls')).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: /1:57/ });
    fireEvent.click(button);
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('carries an English captions track read with CORS', () => {
    const { container } = renderPublic(DATA);
    const video = container.querySelector('video')!;
    expect(video.getAttribute('crossorigin')).toBe('anonymous');
    const track = container.querySelector('track')!;
    expect(track.getAttribute('kind')).toBe('captions');
    expect(track.getAttribute('srclang')).toBe('en');
    expect(track.getAttribute('src')).toBe(DATA.captions);
  });

  it('describes the video with the screen-reader-only description; the title is the visible caption', () => {
    const { container } = renderPublic(DATA);
    const video = container.querySelector('video')!;
    const ids = (video.getAttribute('aria-describedby') ?? '').split(' ');
    const desc = ids.map((id) => document.getElementById(id)).find((el) => el?.textContent === DATA.description);
    expect(desc?.className).toBe('sr-only');
    expect(container.querySelector('figcaption')!.textContent).toContain(DATA.title);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Why companies run it as their own');
  });

  it('links YouTube only when authored', () => {
    renderPublic(DATA);
    const link = screen.getByRole('link', { name: /YouTube/ });
    expect(link.getAttribute('href')).toBe(DATA.youtubeUrl);
    expect(link.getAttribute('rel')).toContain('noopener');
    cleanup();
    const { youtubeUrl: _y, captions: _c, ...rest } = DATA;
    const { container } = renderPublic(rest);
    expect(screen.queryByRole('link', { name: /YouTube/ })).toBeNull();
    expect(container.querySelector('track')).toBeNull();
  });

  it('never renders a player for a non-https source', () => {
    const { container } = renderPublic({ ...DATA, src: 'http://evil.test/a.mp4' });
    expect(container.querySelector('video')).toBeNull();
  });
});

describe('video section — editor', () => {
  it('offers every field and writes the edited value', () => {
    const onChange = vi.fn();
    render(<SectionFields section={section(DATA)} assets={[]} onChange={onChange} />);
    for (const label of [/Video title/, /Video file URL/, /Poster image URL/, /English captions URL/, /YouTube link/, /Length/, /Description for screen readers/]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText(/Length/), { target: { value: '2:05' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ length: '2:05', title: DATA.title }));
  });
});
