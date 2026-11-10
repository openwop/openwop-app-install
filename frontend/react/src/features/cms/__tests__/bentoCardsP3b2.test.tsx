/**
 * ADR 1070 — design batch Phase 3b2: bento tiles and default cards.
 *
 *   - D1: a `tall` tile spans two rows; `tone: 'mist'` is a muted tile.
 *   - D2: a `count` with a `countLabel` is the tile's stat, big, UNDER its text;
 *     a count without a label still leads the tile, as before.
 *   - D3: `imagePosition: 'top'` puts the picture first.
 *   - D4: a tile draws its icon only for a known slug.
 *   - D5: a default card takes its own `tone` (dark or muted).
 *
 * Sabotage witnesses: dropping the tall or mist class, putting the labelled
 * stat back on top (or dropping its label), moving an unlabelled count, keeping
 * the picture at the foot, drawing a glyph for an unknown slug, or ignoring a
 * card's tone reds a case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
const bento = (columns: Record<string, unknown>[]): Section => ({ sectionId: 'sec:loop', type: 'columns', data: { layout: 'bento', columns } });

describe('bento tiles (ADR 1070 D1–D4)', () => {
  it('marks a tall tile and a muted tile', () => {
    const c = renderSection(bento([{ title: 'Tall', text: 'a', tall: true }, { title: 'Mist', text: 'b', tone: 'mist' }, { title: 'Plain', text: 'c' }]));
    const [tall, mist, plain] = [...c.querySelectorAll('.fp-bento__tile')];
    expect(tall!.classList.contains('fp-bento__tile--tall')).toBe(true);
    expect(mist!.classList.contains('fp-bento__tile--mist')).toBe(true);
    expect(plain!.className).not.toMatch(/--tall|--mist/);
  });

  it('puts a labelled number under the text, and leaves an unlabelled one on top', () => {
    const c = renderSection(bento([{ title: 'Built', text: 'Ready on day one.', count: 130, countLabel: 'features, already built' }, { title: 'Old', text: 'x', count: 7 }]));
    const [labelled, plain] = [...c.querySelectorAll('.fp-bento__tile')];
    const stat = labelled!.querySelector('.fp-bento__stat')!;
    expect(stat.querySelector('.fp-bento__count--big')?.textContent).toBe('130');
    expect(stat.querySelector('.fp-bento__count-label')?.textContent).toBe('features, already built');
    expect(labelled!.querySelector('.fp-card__text')!.compareDocumentPosition(stat) & Node.DOCUMENT_POSITION_FOLLOWING, 'under the text').toBeTruthy();
    expect(labelled!.querySelectorAll('.fp-bento__count'), 'one number, not two').toHaveLength(1);
    expect(plain!.firstElementChild!.classList.contains('fp-bento__count'), 'an unlabelled count still leads').toBe(true);
  });

  it('puts the picture first when asked', () => {
    const c = renderSection(bento([{ title: 'Shot', text: 'x', imageToken: 'tok-1', alt: 'The board', imagePosition: 'top' }, { title: 'Foot', text: 'y', imageToken: 'tok-2', alt: 'The run' }]));
    const [top, foot] = [...c.querySelectorAll('.fp-bento__tile')];
    expect(top!.firstElementChild!.classList.contains('fp-bento__shot--top')).toBe(true);
    expect(foot!.lastElementChild!.classList.contains('fp-bento__shot')).toBe(true);
    expect(foot!.querySelector('.fp-bento__shot--top')).toBeNull();
  });

  it('draws an icon only for a known slug', () => {
    const c = renderSection(bento([{ title: 'Plug', text: 'x', icon: 'plug' }, { title: 'Nope', text: 'y', icon: 'no-such-icon' }]));
    const [known, unknown] = [...c.querySelectorAll('.fp-bento__tile')];
    expect(known!.querySelector('.fp-glyph svg')).not.toBeNull();
    expect(unknown!.querySelector('.fp-glyph'), 'no node-motif fallback on a tile').toBeNull();
  });
});

describe('default cards (ADR 1070 D5)', () => {
  it('takes each card\'s own tone', () => {
    const c = renderSection({ sectionId: 'sec:agencies', type: 'columns', data: { layout: 'cards', columns: [{ title: '130 features', text: 'a', tone: 'inverse' }, { title: 'Muted', text: 'b', tone: 'mist' }, { title: 'Plain', text: 'c' }] } });
    const [dark, mist, plain] = [...c.querySelectorAll('.fp-card')];
    expect(dark!.classList.contains('fp-card--inverse') && dark!.classList.contains('fp-tone--inverse')).toBe(true);
    expect(mist!.classList.contains('fp-card--mist')).toBe(true);
    expect(plain!.className).toBe('fp-card');
  });
});
