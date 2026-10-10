import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { parseHeadingEmphasis, stripHeadingEmphasis } from '../headingEmphasis.js';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

describe('parseHeadingEmphasis', () => {
  it('returns one plain run when there are no markers', () => {
    expect(parseHeadingEmphasis('Make progress')).toEqual([{ text: 'Make progress', em: false }]);
    expect(parseHeadingEmphasis('')).toEqual([]);
  });

  it('splits out a matched run', () => {
    expect(parseHeadingEmphasis('Watch, pause, and *rewind.*')).toEqual([
      { text: 'Watch, pause, and ', em: false },
      { text: 'rewind.', em: true },
    ]);
  });

  it('handles multiple runs', () => {
    expect(parseHeadingEmphasis('*One* and *two words* here')).toEqual([
      { text: 'One', em: true },
      { text: ' and ', em: false },
      { text: 'two words', em: true },
      { text: ' here', em: false },
    ]);
  });

  it('renders unmatched and non-emphasis asterisks literally', () => {
    for (const s of ['A lone * star', 'Trailing *open', '2 * 3 * 4', '**bold**', '* spaced *', 'Empty ** pair']) {
      expect(parseHeadingEmphasis(s)).toEqual([{ text: s, em: false }]);
    }
    expect(stripHeadingEmphasis('Odd *one* out *')).toBe('Odd one out *');
  });

  it('strips only matched markers', () => {
    expect(stripHeadingEmphasis('Build workflows you can *rewind.*')).toBe('Build workflows you can rewind.');
  });
});

function view(section: Section) {
  return render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
}

describe('SectionRenderer heading emphasis', () => {
  it('renders the hero heading run as <em> with no literal asterisks', () => {
    view({ sectionId: 'h', type: 'hero', data: { heading: 'Watch, pause, and *rewind.*', visual: 'none' } });
    const h1 = screen.getByRole('heading', { level: 1, name: 'Watch, pause, and rewind.' });
    expect(h1.querySelector('em.fp-em')?.textContent).toBe('rewind.');
    expect(h1.textContent).not.toContain('*');
  });

  it('renders section and cta headings the same way, with an id from the visible text', () => {
    const { container } = view({ sectionId: 'r', type: 'richText', data: { heading: 'Runs you can *trust*', text: 'Body.' } });
    const h2 = screen.getByRole('heading', { level: 2, name: 'Runs you can trust' });
    expect(h2.className).toContain('fp-head__title');
    expect(h2.id).toBe('runs-you-can-trust');
    expect(h2.querySelector('em')?.textContent).toBe('trust');
    expect(container.textContent).not.toContain('*');
    cleanup();
    view({ sectionId: 'c', type: 'cta', data: { heading: 'Start *today*', label: 'Go', url: '/signup' } });
    const cta = screen.getByRole('heading', { level: 2, name: 'Start today' });
    expect(cta.querySelector('em')?.textContent).toBe('today');
  });

  it('leaves an unmatched asterisk literal', () => {
    view({ sectionId: 'h', type: 'hero', data: { heading: 'Five * stars', visual: 'none' } });
    const h1 = screen.getByRole('heading', { level: 1, name: 'Five * stars' });
    expect(h1.querySelector('em')).toBeNull();
  });
});
