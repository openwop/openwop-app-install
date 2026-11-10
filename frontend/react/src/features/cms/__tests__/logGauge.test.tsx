/**
 * ADR 1064 P3d — the hero `log` visual and the card ring gauge.
 *
 * Log: a figure named by its caption, a decorative title bar, and the lines as
 * a real ordered list (time, event, detail), coloured by state. Only complete
 * lines (with an event) show, and the cursor sits on the last line and is
 * decoration. Gauge: a card with `gauge` shows a decorative ring filled to its
 * `progress`, with the gauge's words as real text, in place of the glyph.
 *
 * Red when: a line loses its text or order, an event-less line renders, the
 * state class drops, the cursor is announced or repeated, the gauge's words
 * leave the DOM, or the ring stops following `progress`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);
const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;

describe('hero log visual', () => {
  it('renders the run as an ordered list of real lines', () => {
    const c = renderSection({
      sectionId: 'sec:contact-hero', type: 'hero',
      data: {
        heading: 'Talk to us', visual: 'log',
        log: {
          label: 'A recorded run', title: 'run · follow-up-signups · recorded',
          lines: [
            { time: '21:02:04', event: 'run.started', detail: 'trigger=form' },
            { time: '21:03:03', event: 'approval.requested', detail: 'send-replies', state: 'waiting' },
            { time: '', event: '', detail: 'half-written' },
            { time: '07:31:18', event: 'approval.granted', detail: 'by you', state: 'done' },
          ],
        },
      },
    });
    expect(screen.getByRole('figure', { name: 'A recorded run' })).toBeTruthy();
    expect(c.querySelector('.fp-log__bar')?.getAttribute('aria-hidden')).toBe('true');
    const lines = [...c.querySelectorAll<HTMLElement>('ol.fp-log__lines > li')];
    expect(lines.map((l) => l.textContent)).toEqual(['21:02:04run.startedtrigger=form', '21:03:03approval.requestedsend-replies', '07:31:18approval.grantedby you']);
    expect(lines.map((l) => l.className)).toEqual(['fp-log__line', 'fp-log__line fp-log__line--waiting', 'fp-log__line fp-log__line--done']);
    const cursors = c.querySelectorAll('.fp-log__cursor');
    expect(cursors).toHaveLength(1);
    expect(lines[2]!.contains(cursors[0]!)).toBe(true);
    expect(cursors[0]!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('card ring gauge', () => {
  it('shows the gauge words as text and a ring filled to progress', () => {
    const c = renderSection({
      sectionId: 'sec:pillars', type: 'columns',
      data: { layout: 'cards', columns: [{ title: 'The test results', text: 'All 415 scenarios passed.', gauge: '415/415', progress: 1 }, { title: 'The engine', text: 'Pause and rewind.', gauge: '3/4', progress: 0.75 }] },
    });
    const gauges = [...c.querySelectorAll<HTMLElement>('.fp-gauge')];
    expect(gauges.map((g) => g.querySelector('.fp-gauge__label')?.textContent)).toEqual(['415/415', '3/4']);
    expect(gauges[1]!.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(gauges[1]!.querySelector<SVGElement>('.fp-gauge__fill')?.style.strokeDasharray).toBe('75 100');
    // The gauge takes the glyph's place.
    expect(c.querySelector('.fp-card .fp-glyph')).toBeNull();
  });

  it('leads a bento tile too, before its eyebrow, and a tile without one has no ring', () => {
    const c = renderSection({
      sectionId: 'sec:mh-contact-pillars', type: 'columns',
      data: { layout: 'bento', columns: [{ eyebrow: 'Conformance', title: 'Tested', text: 'Every scenario passes.', gauge: '418 of 418', progress: 0.5 }, { title: 'Plain', text: 'No gauge here.' }] },
    });
    const tiles = [...c.querySelectorAll<HTMLElement>('.fp-bento__tile')];
    const g = tiles[0]!.querySelector<HTMLElement>('.fp-gauge');
    if (!g) throw new Error('the first tile must lead with a gauge');
    expect(g.querySelector('.fp-gauge__label')?.textContent).toBe('418 of 418');
    expect(g.querySelector<SVGElement>('.fp-gauge__fill')?.style.strokeDasharray).toBe('50 100');
    expect(g.nextElementSibling?.className).toBe('fp-bento__eyebrow');
    expect(tiles[1]!.querySelector('.fp-gauge')).toBeNull();
  });
});
