/**
 * ADR 0328 Phase 3 — blocks-based slides in the ONE deck renderer: the closed
 * 12-type BlockView, variant classes, unknown-type forward-compat, and the
 * untrusted-image posture (safeImageSrc) on the image block.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SlidesContentView } from '../SlidesPreview.js';

afterEach(cleanup);

const deck = (slides: unknown[]): string => JSON.stringify({ title: 'Deck', slides });

function renderDeck(slides: unknown[]): HTMLElement {
  const { container } = render(<MemoryRouter><SlidesContentView content={deck(slides)} /></MemoryRouter>);
  return container;
}

describe('blocks slides — BlockView', () => {
  it('renders headings, text, bullets, quote, callout, code, table, and statCard from the block tree', () => {
    const c = renderDeck([{
      layout: 'blocks',
      variant: 'full',
      blocks: [
        { type: 'heading', props: { text: 'Q3 Review', level: '1' } },
        { type: 'text', props: { text: 'A strong quarter.', size: 'lg', tone: 'muted' } },
        { type: 'bullets', props: { items: ['Revenue up', 'Churn down'] } },
        { type: 'quote', props: { text: 'Best yet', attribution: 'CEO' } },
        { type: 'callout', props: { text: 'Heads up', tone: 'warning' } },
        { type: 'code', props: { text: 'const x = 1;' } },
        { type: 'table', props: { columns: 'Region, ARR', rows: 'EMEA, 4.2M\nAMER, 9.1M' } },
        { type: 'statCard', props: { label: 'NRR', value: '118%', delta: '+6pts' } },
        { type: 'divider' },
        { type: 'spacer', props: { size: 'lg' } },
      ],
    }]);
    expect(c.querySelector('.canvas-slides__blk-heading--l1')?.textContent).toBe('Q3 Review');
    expect(c.querySelector('.canvas-slides__blk-text--lg.canvas-slides__blk-tone--muted')?.textContent).toBe('A strong quarter.');
    expect([...c.querySelectorAll('.canvas-slides__bullets li')].map((li) => li.textContent)).toEqual(['Revenue up', 'Churn down']);
    expect(c.querySelector('blockquote')?.textContent).toBe('Best yet');
    expect(c.querySelector('.canvas-slides__blk-callout--warning')?.textContent).toBe('Heads up');
    expect(c.querySelector('.canvas-slides__blk-code code')?.textContent).toBe('const x = 1;');
    expect([...c.querySelectorAll('.canvas-slides__blk-table th')].map((th) => th.textContent)).toEqual(['Region', 'ARR']);
    expect(c.querySelectorAll('.canvas-slides__blk-table tbody tr').length).toBe(2);
    expect(c.querySelector('.canvas-slides__blk-stat-value')?.textContent).toBe('118%');
    expect(c.querySelector('.canvas-slides__blk-stat-delta')?.textContent).toBe('+6pts');
    expect(c.querySelector('.canvas-slides__blk-divider')).not.toBeNull();
    expect(c.querySelector('.canvas-slides__blk-spacer--lg')).not.toBeNull();
  });

  it('applies the variant class and defaults unknown variants to full', () => {
    const hero = renderDeck([{ layout: 'blocks', variant: 'hero', blocks: [{ type: 'heading', props: { text: 'T' } }] }]);
    expect(hero.querySelector('.canvas-slides__body--v-hero')).not.toBeNull();
    const odd = renderDeck([{ layout: 'blocks', variant: 'diagonal', blocks: [] }]);
    expect(odd.querySelector('.canvas-slides__body--v-full')).not.toBeNull();
  });

  it('ignores unknown block types (forward-compat) and blocks unsafe image sources', () => {
    const c = renderDeck([{
      layout: 'blocks',
      blocks: [
        { type: 'hologram', props: { text: 'nope' } },
        { type: 'image', props: { src: 'javascript:alert(1)', caption: 'evil' } },
        { type: 'image', props: { src: 'https://ok.example/a.png', caption: 'fine' } },
      ],
    }]);
    expect(c.textContent).not.toContain('nope');
    // The SECURITY property is unchanged: the unsafe src never reaches an <img>.
    const imgs = [...c.querySelectorAll('img')];
    expect(imgs.length).toBe(1);
    expect(imgs[0]?.getAttribute('src')).toBe('https://ok.example/a.png');
    // R2 SL-SP-6 — the blocked image now leaves a WITNESS (a labelled
    // placeholder) instead of silently rendering nothing; its caption (plain
    // escaped text) stays. The old pin asserted silence, which read as a
    // missing slide to the audience.
    expect(c.querySelector('.canvas-slides__img-fallback')?.textContent).toBe('Image unavailable');
    const captions = [...c.querySelectorAll('figcaption')].map((f) => f.textContent);
    expect(captions).toEqual(['evil', 'fine']);
  });

  it('renders a chart block through the shared ChartRenderer', () => {
    const c = renderDeck([{
      layout: 'blocks',
      blocks: [{ type: 'chart', props: { spec: JSON.stringify({ chartType: 'bar', data: { labels: ['A'], datasets: [{ data: [3] }] } }) } }],
    }]);
    expect(c.querySelector('.canvas-slides__blk-chart svg')).not.toBeNull();
  });
});

// ── ADR 0328 Phase 5 — motion keys + build gating on the renderer. ─────────
describe('blocks slides — motion (ADR 0328 P5)', () => {
  it('stamps stable content keys as data-mm, disambiguating duplicates', () => {
    const c = renderDeck([{
      layout: 'blocks',
      blocks: [
        { type: 'heading', props: { text: 'Same' } },
        { type: 'heading', props: { text: 'Same' } },
        { type: 'image', props: { src: 'https://ok.example/a.png' } },
      ],
    }]);
    const keys = [...c.querySelectorAll('[data-mm]')].map((el) => el.getAttribute('data-mm'));
    expect(keys).toEqual(['heading:Same', 'heading:Same#1', 'image:https://ok.example/a.png']);
  });
});
