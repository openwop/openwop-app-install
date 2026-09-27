/**
 * UX_UPGRADE-site R2-G10 — the `faq` + `quotes` public sections.
 *
 * Pinned behaviours: faq renders native <details>/<summary> (a real disclosure
 * per pair — keyboard/SR for free); quotes renders <figure>/<blockquote> with a
 * byline ONLY when authored (an unattributed quote never grows an invented
 * one); both stay silent when item-less (schema forbids authoring them empty;
 * an emptied overlay must degrade to nothing, not crash).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const renderSection = (section: Section) =>
  render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);

describe('faq section', () => {
  it('renders one disclosure per Q/A pair', () => {
    renderSection({ sectionId: 'f1', type: 'faq', data: {
      heading: 'FAQ',
      items: [
        { q: 'How is pricing calculated?', a: 'Per workspace.' },
        { q: 'Can I export?', a: 'Yes, everything.' },
      ],
    } });
    expect(screen.getByRole('heading', { name: 'FAQ' })).toBeTruthy();
    const groups = screen.getAllByRole('group'); // <details> maps to role=group
    expect(groups).toHaveLength(2);
    expect(within(groups[0]!).getByText('How is pricing calculated?')).toBeTruthy();
    expect(within(groups[0]!).getByText('Per workspace.')).toBeTruthy();
  });

  it('renders nothing for an item-less faq (emptied overlay degrades silently)', () => {
    const { container } = renderSection({ sectionId: 'f2', type: 'faq', data: { heading: 'FAQ', items: [] } });
    expect(container.querySelector('details')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'FAQ' })).toBeNull();
  });
});

describe('quotes section', () => {
  it('renders blockquotes; byline only when authored — never invented', () => {
    const { container } = renderSection({ sectionId: 'q1', type: 'quotes', data: {
      heading: 'Loved by teams',
      items: [
        { quote: 'It shipped our launch.', name: 'Ana', role: 'CTO, Acme' },
        { quote: 'Anonymous praise.' },
      ],
    } });
    expect(screen.getByRole('heading', { name: 'Loved by teams' })).toBeTruthy();
    const figures = container.querySelectorAll('figure');
    expect(figures).toHaveLength(2);
    expect(within(figures[0]! as HTMLElement).getByText('Ana')).toBeTruthy();
    expect(within(figures[0]! as HTMLElement).getByText('CTO, Acme')).toBeTruthy();
    // The unattributed quote has NO figcaption at all.
    expect(figures[1]!.querySelector('figcaption')).toBeNull();
  });
});
