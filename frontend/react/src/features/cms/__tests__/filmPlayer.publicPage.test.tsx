/**
 * ADR 0843 — the one film player, as a first-time public visitor gets it.
 *
 * 1. Its copy lives in the LAZY `site` namespace (ADR 0490). The suite preloads
 *    every lazy namespace (src/test/i18n-setup.ts), so no other test can see a
 *    component that reads `site:` through the global `i18n.t` — which never asks
 *    for the namespace and never re-renders. On a CMS page nothing else requests
 *    `site`, so the play button painted the raw key "filmPlay" for good. Here
 *    the bundle is genuinely removed (the state a first visit sees) and the real
 *    backend read must deliver it.
 * 2. When the film plays, the play button fades and is aria-hidden. Focus must
 *    have left it first: an aria-hidden ancestor of the focused element is an
 *    a11y error (Chrome blocks it and logs "Blocked aria-hidden on an element
 *    because its descendant retained focus"). A <video> without `controls` is not
 *    focusable, so the old `v.focus()` was a no-op and focus stayed on the button.
 *
 * Sabotage-witnessed (w85): binding FilmPlayer's `t` to the `cms` namespace only
 * (`site` is never requested) reds the first case, because the raw key paints and stays. Dropping the
 * video's pre-start `tabIndex={-1}` reds the second and third. Dropping `start()`'s
 * `v.focus()` reds the second, and so does `aria-hidden={false}`. `controls={false}`
 * reds the third, and so does a `tabIndex` that stays -1 after start.
 *
 * Ceiling: the `onPlay` hand-off (`moveFocusToVideo`) cannot be observed here.
 * `start()` has already focused the video, and after the click a started
 * `<video controls>` with no tabindex is not focusable in jsdom, so removing that
 * call stays green (probe w85g1-fp-onplay-nohandoff, vacuous by construction).
 * That copy needs a browser check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../../i18n/index.js';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

// Restore the preloaded bundle after the removal case, so each case stands alone.
const SITE = { ...(i18n.getResourceBundle('en', 'site') as Record<string, unknown>) };
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (!i18n.exists('site:filmPlay')) i18n.addResourceBundle('en', 'site', SITE, true, true);
});

const VIDEO: Section = {
  sectionId: 'v1',
  type: 'video',
  data: {
    title: 'A film',
    length: '1:57',
    src: 'https://example.test/film.mp4',
    poster: 'https://example.test/poster.jpg',
  },
};

const renderFilm = () => render(
  <MemoryRouter>
    <Suspense fallback={<p>Loading page</p>}>
      <RenderSection section={VIDEO} mode="public" />
    </Suspense>
  </MemoryRouter>,
);

describe('film player on a public page', () => {
  it('loads the lazy `site` namespace itself and never leaves the raw key painted', async () => {
    // i18next types `backendConnector` as `any`; name only the field this case touches.
    const connector: { state: Record<string, unknown> } = i18n.services.backendConnector;
    i18n.removeResourceBundle('en', 'site');
    delete connector.state['en|site'];
    expect(i18n.exists('site:filmPlay')).toBe(false);

    const { container } = renderFilm();

    expect(await screen.findByText('Watch the video')).toBeTruthy();
    expect(container.textContent).not.toContain('filmPlay');
  });

  it('moves focus to the video before the play button is aria-hidden', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { container } = renderFilm();
    const video = container.querySelector('video')!;
    const button = screen.getByRole('button', { name: /Watch the video/ });

    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.play(video);

    expect(button.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(video);
    expect(document.activeElement!.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('keeps the unstarted video out of the tab order, and hands it to native controls once started', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { container } = renderFilm();
    const video = container.querySelector('video')!;
    expect(video.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(screen.getByRole('button', { name: /Watch the video/ }));
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('tabindex')).toBe(false);
  });
});
