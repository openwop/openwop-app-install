/**
 * ADR 0762 — the launch-story treatments: the demo-gated intro film, example
 * prompts, drawn deep dives, and a stats band with its section head.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const demo = vi.hoisted(() => ({ on: false }));
vi.mock('../../../client/useDemoMode.js', () => ({ useDemoMode: () => demo.on }));

import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(() => { cleanup(); demo.on = false; });

const view = (section: Section) => render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
const hero = (data: Record<string, unknown>): Section => ({ sectionId: 'h', type: 'hero', data: { heading: 'Build agents', ...data } });

describe('hero visual: film', () => {
  it('renders the run ledger instead when the host is not the demo (no openwop.dev media)', () => {
    const { container } = view(hero({ visual: 'film' }));
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.fp-hero--run .fp-run')).toBeTruthy();
  });

  it('on the demo, renders the film click-to-play under the copy', () => {
    demo.on = true;
    const { container } = view(hero({ visual: 'film', ctaLabel: 'Start', ctaUrl: '/chat' }));
    const video = container.querySelector<HTMLVideoElement>('.fp-hero--film video');
    expect(video).toBeTruthy();
    expect(video!.getAttribute('preload')).toBe('none');
    expect(video!.getAttribute('src')).toMatch(/^https:\/\/openwop\.dev\/assets\/video\/openwop-intro\.mp4\?v=/);
    expect(video!.getAttribute('poster')).toMatch(/^https:\/\/openwop\.dev\//);
    expect(video!.hasAttribute('controls')).toBe(false);
    // Narrated: an English captions track, read cross-origin from openwop.dev.
    expect(video!.getAttribute('crossorigin')).toBe('anonymous');
    const track = video!.querySelector('track');
    expect(track?.getAttribute('kind')).toBe('captions');
    expect(track?.getAttribute('srclang')).toBe('en');
    expect(track?.getAttribute('src')).toMatch(/^https:\/\/openwop\.dev\/assets\/video\/openwop-intro\.en\.vtt\?v=/);
    // Described by its caption; the heading and CTA stay real content.
    const cap = container.querySelector('figcaption');
    expect(video!.getAttribute('aria-describedby')).toBe(cap?.id);
    expect(screen.getByRole('heading', { level: 1, name: 'Build agents' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start' })).toBeTruthy();
  });

  it('the play button fades out while the video plays and back in when it ends', () => {
    demo.on = true;
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { container } = view(hero({ visual: 'film' }));
    const btn = container.querySelector<HTMLButtonElement>('.fp-film__play')!;
    const video = container.querySelector('video')!;
    expect(btn.textContent).toContain('Watch the video');
    fireEvent.click(btn);
    expect(play).toHaveBeenCalled();
    expect(video.hasAttribute('controls')).toBe(true);
    fireEvent.play(video);
    expect(btn.classList.contains('fp-film__play--faded')).toBe(true);
    expect(btn.getAttribute('aria-hidden')).toBe('true');
    expect(btn.tabIndex).toBe(-1);
    fireEvent.ended(video);
    expect(btn.classList.contains('fp-film__play--faded')).toBe(false);
    expect(btn.getAttribute('aria-hidden')).toBe('false');
    expect(btn.tabIndex).toBe(0);
    play.mockRestore();
  });
});

describe('columns layout: prompts', () => {
  it('renders each prompt as a quotation with its tag, linked where it can be typed', () => {
    view({ sectionId: 'p', type: 'columns', data: { heading: 'What will you run first?', layout: 'prompts', columns: [
      { title: 'approval', text: 'Ask finance before paying.', href: '/chat' },
      { title: 'budget cap', text: 'Stop if it spends more than $2.' },
    ] } });
    const quotes = [...document.querySelectorAll('q.fp-prompt__text')].map((q) => q.textContent);
    expect(quotes).toEqual(['Ask finance before paying.', 'Stop if it spends more than $2.']);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/chat']);
    expect(document.querySelectorAll('.fp-prompt__tag')).toHaveLength(2);
  });
});

describe('columns layout: dives', () => {
  it('numbers each claim and draws a decorative illustration per known icon slug', () => {
    const { container } = view({ sectionId: 'd', type: 'columns', data: { heading: 'Four things', layout: 'dives', columns: [
      { title: 'Build', text: 'On a canvas.', icon: 'canvas' },
      { title: 'Run', text: 'Watch it.', icon: 'ledger' },
      { title: 'Decide', text: 'It waits.', icon: 'approval' },
      { title: 'Replay', text: 'Rewind it.', icon: 'fork' },
      { title: 'Other', text: 'No art.', icon: 'nope' },
    ] } });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Build', 'Run', 'Decide', 'Replay', 'Other']);
    const art = [...container.querySelectorAll('.fp-dive__art')];
    expect(art).toHaveLength(4);
    for (const a of art) expect(a.getAttribute('aria-hidden')).toBe('true');
    // The illustrations offer nothing to click: no buttons or links inside them.
    expect(container.querySelectorAll('.fp-dive__art a, .fp-dive__art button')).toHaveLength(0);
  });
});

describe('columns layout: stats', () => {
  it('draws its section head when authored, and still renders bare', () => {
    view({ sectionId: 's', type: 'columns', data: { eyebrow: 'Measured', heading: 'Checked against the protocol', lede: 'Self-measured.', layout: 'stats', columns: [{ title: '296', text: 'requirements witnessed' }] } });
    expect(screen.getByRole('heading', { level: 2, name: 'Checked against the protocol' })).toBeTruthy();
    expect(screen.getByText('Self-measured.')).toBeTruthy();
    cleanup();
    const { container } = view({ sectionId: 's2', type: 'columns', data: { layout: 'stats', columns: [{ title: '0', text: 'failed' }] } });
    expect(container.querySelector('.fp-head')).toBeNull();
    expect(container.querySelector('.fp-stat__value')?.textContent).toBe('0');
  });
});
