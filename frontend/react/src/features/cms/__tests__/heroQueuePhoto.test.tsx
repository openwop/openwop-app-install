/**
 * #5779 B7 (ADR 1080 D19) — the hero queue over a photo.
 *
 * A `visual: 'queue'` hero with an `imageToken` draws the photo with the queue
 * card in one stage (`fp-hero__queue-stage`, the photo first), and from 900px
 * the card overlaps the photo's lower edge. Without a photo the hero keeps its
 * exact markup: the queue is a direct child of the grid and no new class is set.
 *
 * Sabotage witnesses: dropping the stage, putting the card before the photo,
 * setting `fp-hero--queue-photo` on a hero with no photo, or removing the
 * overlap rule each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '..', 'designSections.css'), 'utf8');
const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
const queue = { title: 'Before the walls close', rows: [{ id: 'PLB-018', title: 'Shower valve', status: 'No owner', tone: 'bad' }] };

describe('hero queue over a photo (#5779 B7)', () => {
  it('sets the queue card after the photo in one stage', () => {
    const c = renderSection({ sectionId: 'sec:hero', type: 'hero', data: { heading: 'Every selection', visual: 'queue', imageToken: 'tok-h', alt: 'A tiled shower', queue } });
    expect(c.querySelector('section.fp-hero')!.classList.contains('fp-hero--queue-photo')).toBe(true);
    const stage = c.querySelector('.fp-hero__grid > .fp-hero__queue-stage')!;
    expect(stage).not.toBeNull();
    const kids = [...stage.children];
    expect(kids.map((k) => k.tagName)).toEqual(['IMG', 'FIGURE']);
    expect(kids[0]!.getAttribute('alt')).toBe('A tiled shower');
    expect(kids[1]!.classList.contains('fp-queue')).toBe(true);
  });

  it('leaves a queue hero with no photo exactly as before', () => {
    const c = renderSection({ sectionId: 'sec:hero', type: 'hero', data: { heading: 'Every selection', visual: 'queue', queue } });
    expect(c.querySelector('section.fp-hero')!.classList.contains('fp-hero--queue-photo')).toBe(false);
    expect(c.querySelector('.fp-hero__queue-stage')).toBeNull();
    expect(c.querySelector('.fp-hero__grid > figure.fp-queue')).not.toBeNull();
    expect(c.querySelector('img')).toBeNull();
  });

  it('overlaps the photo from 900px and stacks below it', () => {
    const wide = css.match(/@media \(min-width: 900px\) \{\s*\.fp-hero__queue-stage \{ gap: 0; \}\s*\.fp-hero__queue-stage \.fp-queue \{([^}]*)\}/);
    expect(wide, 'the 900px overlap rule').not.toBeNull();
    expect(wide![1]).toMatch(/margin: calc\(var\(--space-6\) \* -\d+\)/);
    expect(css).toMatch(/\.fp-hero__queue-stage \{ display: grid; gap: var\(--space-4\);/);
  });
});
