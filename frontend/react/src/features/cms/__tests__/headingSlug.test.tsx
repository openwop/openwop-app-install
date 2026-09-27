/**
 * UX_UPGRADE-docs R2-D10 — stable heading anchors in the shared renderer.
 *
 * The fixture cases here are BYTE-IDENTICAL to the backend suite's
 * (`backend/typescript/test/adr0384-section-html.test.ts` "headingSlug parity"
 * describe): the SPA and the prerender emit the same ids from the same text,
 * or fragment links resolve in one and not the other. Change one side's
 * algorithm and the other side's copy of these cases goes red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { headingSlug } from '../headingSlug.js';
import { RenderSection } from '../SectionRenderer.js';

afterEach(cleanup);

/** KEEP IN LOCKSTEP with the backend copy of these cases. */
const PARITY_CASES: Array<[string, string]> = [
  ['How is pricing calculated?', 'how-is-pricing-calculated'],
  ['Café Ünïcode — done!', 'cafe-unicode-done'],
  ['***', 'section'],
  ['A'.repeat(80), 'a'.repeat(64)],
  ['  spaced   out  ', 'spaced-out'],
];

describe('headingSlug (shared algorithm)', () => {
  it.each(PARITY_CASES)('%s → %s', (text, slug) => {
    expect(headingSlug(text)).toBe(slug);
  });
});

describe('SectionHead anchor ids (R2-D10)', () => {
  it('a section heading carries its stable slug id', () => {
    render(
      <MemoryRouter>
        <RenderSection section={{ sectionId: 's1', type: 'richText', data: { heading: 'How is pricing calculated?', text: 'Body.' } }} mode="public" />
      </MemoryRouter>,
    );
    const h = screen.getByRole('heading', { name: 'How is pricing calculated?' });
    expect(h.id).toBe('how-is-pricing-calculated');
  });
});
