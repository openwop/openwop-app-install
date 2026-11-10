/**
 * ADR 1062 D4 — the `cta` section's `split` alignment and `note`.
 *
 * `split` puts the copy and the button side by side on wide screens (the
 * design's default CTA band); `start` keeps the button under left-aligned copy.
 * A `note` renders under the button, through inline markdown, never inside
 * the body copy.
 *
 * Red when: `split` stops adding `fp-cta--split`, the note moves out of the
 * actions column or stops rendering, is also copied into the copy column, or
 * renders above the button, or a note-less CTA grows an empty note.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function cta(data: Record<string, unknown>): HTMLElement {
  const section: Section = { sectionId: 'sec:cta', type: 'cta', data: { heading: 'Ready?', subheading: 'Talk to a person.', label: 'Book a call', url: '/p/book', ...data } };
  const { container } = render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
  return container.querySelector('section.fp-cta') as HTMLElement;
}

describe('cta split + note', () => {
  it('split marks the section and keeps the copy and the actions as two columns', () => {
    const s = cta({ align: 'split', note: 'No card needed. [Pricing](/pricing)' });
    expect(s.classList.contains('fp-cta--split')).toBe(true);
    const inner = s.querySelector('.fp-cta__inner') as HTMLElement;
    expect([...inner.children].map((c) => c.className)).toEqual(['fp-cta__copy', 'fp-cta__actions']);
    const actions = inner.querySelector('.fp-cta__actions') as HTMLElement;
    const note = actions.querySelector('.fp-cta__note') as HTMLElement;
    expect(note.textContent).toBe('No card needed. Pricing');
    expect(within(note).getByRole('link', { name: 'Pricing' }).getAttribute('href')).toBe('/pricing');
    // The note sits under the button.
    const button = within(actions).getByRole('link', { name: 'Book a call' });
    expect(button.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The note is not part of the body copy.
    expect(s.querySelector('.fp-cta__lede')?.textContent).toBe('Talk to a person.');
    expect(inner.querySelector('.fp-cta__copy')?.textContent).not.toContain('No card needed');
  });

  it('start and center keep their own classes; no note renders no paragraph', () => {
    expect(cta({ align: 'start' }).classList.contains('fp-cta--start')).toBe(true);
    const center = cta({});
    expect(center.classList.contains('fp-cta--split')).toBe(false);
    expect(center.classList.contains('fp-cta--start')).toBe(false);
    expect(center.querySelector('.fp-cta__note')).toBeNull();
  });
});
