/**
 * CMS-R2-1 — preview→editor click-through (the Storyblok block↔preview
 * contract, adapted to our portal preview). The invariants worth pinning:
 *   - the LIVE-page path (no `onEditSection`) renders neither wrapper nor
 *     chip — the public markup (and its `>`-combinator stagger) is untouched
 *   - the preview path reports the CLICKED section's id, not the first
 *     (the multi-instance discipline)
 *   - SectionsEditor lands a focusRequest on the RIGHT card: scrolls it,
 *     moves focus to it, and a repeat request (new nonce) re-fires
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSections } from '../SectionRenderer.js';
import { SectionsEditor } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

const SECTIONS: Section[] = [
  { sectionId: 's-hero', type: 'hero', data: { heading: 'Welcome' } },
  { sectionId: 's-prose', type: 'prose', data: { markdown: 'Body copy.' } },
];

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('RenderSections click-through affordance', () => {
  it('renders NO wrapper and NO edit chip on the live-page path (no callback)', () => {
    render(<MemoryRouter><RenderSections sections={SECTIONS} mode="public" /></MemoryRouter>);
    expect(document.querySelector('.cms-pv-section')).toBeNull();
    expect(screen.queryByRole('button', { name: /edit the/i })).toBeNull();
  });

  it('reports the CLICKED section id — the second chip, not the first', () => {
    const onEdit = vi.fn();
    render(<MemoryRouter><RenderSections sections={SECTIONS} mode="public" onEditSection={onEdit} /></MemoryRouter>);
    const chips = screen.getAllByRole('button', { name: /edit the/i });
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]!);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('s-prose');
  });
});

describe('SectionsEditor focusRequest landing', () => {
  it('scrolls to and FOCUSES the requested card, and a new nonce re-fires', () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); });
    const { rerender } = render(
      <SectionsEditor sections={SECTIONS} assets={[]} onChange={() => {}} focusRequest={{ sectionId: 's-prose', nonce: 1 }} />,
    );
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.getAttribute('data-section-id')).toBe('s-prose');
    expect(document.activeElement?.getAttribute('data-section-id')).toBe('s-prose');

    rerender(
      <SectionsEditor sections={SECTIONS} assets={[]} onChange={() => {}} focusRequest={{ sectionId: 's-prose', nonce: 2 }} />,
    );
    expect(scrolled).toHaveLength(2); // the nonce contract: same section, re-click, re-scroll
  });

  it('ignores a request for a section that is not on the page (no throw, no scroll)', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <SectionsEditor sections={SECTIONS} assets={[]} onChange={() => {}} focusRequest={{ sectionId: 's-gone', nonce: 1 }} />,
    );
    expect(scroll).not.toHaveBeenCalled();
  });
});
