/**
 * ADR 1064 P3f — the About page pieces: source pills, a pull quote, and a
 * timeline's picture beside the rail.
 *
 * A rich text with `sources: true` renders each inline code span as a <cite>
 * pill (a citation, not code); without it, code stays code. `quotes` with
 * `style: 'pull'` marks the pull variant and keeps real figure/blockquote
 * semantics. A `timeline` with a picture puts it after the rail inside the body
 * (with alt text); without one the timeline is unchanged. A hero picture's
 * annotation chips (P3f d) sit at their corners as decoration (aria-hidden);
 * the hero copy carries their words.
 *
 * Red when: a source becomes code (or code becomes a cite without the flag),
 * the pull class drops, the quote loses its blockquote, the timeline picture
 * drops its alt or leaves the body, a plain timeline changes shape, or the
 * chips stop dropping empty text, an unknown corner, or a fifth chip.
 *
 * Sabotage-witnessed (w92, /grade-tests): code always or never a cite, the
 * flag unwired on the plain or the chat-picture rich text, the pull class or
 * blockquote dropped, the shot before the rail or without its class or alt, a
 * shot on a plain timeline, the chip text, corner or four-chip cap filters
 * loosened, chips announced, and annotations on a chip-less picture each turn
 * a case here red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);
const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
const TEXT = 'Sam Altman has a bet on it `Fortune, 2024`. More than a third are solo `Carta, H1 2025`.';

describe('rich text sources', () => {
  it('renders code spans as cite pills when sources is on', () => {
    const c = renderSection({ sectionId: 's', type: 'richText', data: { text: TEXT, sources: true } });
    expect([...c.querySelectorAll('cite.fp-src')].map((e) => e.textContent)).toEqual(['Fortune, 2024', 'Carta, H1 2025']);
    expect(c.querySelector('code')).toBeNull();
  });

  it('renders cite pills beside a chat picture too', () => {
    const c = renderSection({ sectionId: 's', type: 'richText', data: { text: TEXT, sources: true, visual: 'chat', chat: { title: 'Ask the guide', messages: [{ from: 'person', text: 'Is anyone solo?' }] } } });
    expect(c.querySelector('.fp-chat')).not.toBeNull();
    expect([...c.querySelectorAll('cite.fp-src')].map((e) => e.textContent)).toEqual(['Fortune, 2024', 'Carta, H1 2025']);
    expect(c.querySelector('code')).toBeNull();
  });

  it('keeps code as code without the flag', () => {
    const c = renderSection({ sectionId: 's', type: 'richText', data: { text: TEXT } });
    expect(c.querySelectorAll('code.fp-code')).toHaveLength(2);
    expect(c.querySelector('cite')).toBeNull();
  });
});

describe('pull quote', () => {
  it('marks the pull variant and keeps quote semantics', () => {
    const c = renderSection({ sectionId: 'q', type: 'quotes', data: { style: 'pull', items: [{ quote: 'One person, four live apps.', name: 'David' }] } });
    expect(c.querySelector('.fp-quotes')?.classList.contains('fp-quotes--pull')).toBe(true);
    expect(c.querySelector('figure.fp-quote blockquote p')?.textContent).toBe('One person, four live apps.');
  });
});

describe('timeline picture', () => {
  const cols = [{ eyebrow: '2024', title: 'Started', text: 'One app.' }, { eyebrow: '2026', title: 'Four apps', text: 'Live.' }];

  it('puts the picture after the rail, inside the body, with its alt', () => {
    const c = renderSection({ sectionId: 't', type: 'columns', data: { layout: 'timeline', columns: cols, imageToken: 'med_tl', alt: 'The app list', frameUrl: 'app.example/apps' } });
    expect(c.querySelector('section')?.classList.contains('fp-timeline--shot')).toBe(true);
    const body = c.querySelector('.fp-timeline__body')!;
    expect([...body.children].map((e) => e.className.split(' ')[0])).toEqual(['fp-timeline__list', 'fp-timeline__shot']);
    expect(body.querySelector('img')?.getAttribute('alt')).toBe('The app list');
  });

  it('without a picture, the timeline has no shot', () => {
    const c = renderSection({ sectionId: 't', type: 'columns', data: { layout: 'timeline', columns: cols } });
    expect(c.querySelector('.fp-timeline--shot, .fp-timeline__shot')).toBeNull();
    expect(c.querySelectorAll('.fp-timeline__item')).toHaveLength(2);
  });
});

describe('hero picture annotation chips', () => {
  it('pins up to four decorative chips at their corners', () => {
    // Dropped: an empty chip, an unknown corner, and the fifth valid chip (last,
    // where only the cap can remove it).
    const chipsIn = [
      { text: 'Four live apps', at: 'tl' }, { text: 'One person', at: 'br' }, { text: '', at: 'tr' },
      { text: 'Bad corner', at: 'mid' }, { text: 'Since 2024', at: 'bl' }, { text: 'Remote', at: 'tr' }, { text: 'Fifth', at: 'tl' },
    ];
    const c = renderSection({ sectionId: 'h', type: 'hero', data: { heading: 'About', visual: 'image', imageToken: 'med_face', alt: 'David at his desk', chips: chipsIn } });
    const wrap = c.querySelector('.fp-hero__annotated')!;
    expect(wrap.querySelector('img')?.getAttribute('alt')).toBe('David at his desk');
    const chips = [...wrap.querySelectorAll('.fp-hero__chip')];
    expect(chips.map((e) => [e.textContent, e.className.split(' ')[1], e.getAttribute('aria-hidden')]))
      .toEqual([
        ['Four live apps', 'fp-hero__chip--tl', 'true'], ['One person', 'fp-hero__chip--br', 'true'],
        ['Since 2024', 'fp-hero__chip--bl', 'true'], ['Remote', 'fp-hero__chip--tr', 'true'],
      ]);
  });

  it('without chips, the picture renders as before', () => {
    const c = renderSection({ sectionId: 'h', type: 'hero', data: { heading: 'About', visual: 'image', imageToken: 'med_face', alt: 'David' } });
    expect(c.querySelector('.fp-hero__annotated')).toBeNull();
    expect(c.querySelector('img.fp-hero__image')?.getAttribute('alt')).toBe('David');
  });
});
