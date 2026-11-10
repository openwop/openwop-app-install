/**
 * ADR 1074 — design batch Phase 3c3: a richText screenshot beside the copy
 * (`visual: 'image'`).
 *
 *   - the copy (head + essay) and the screenshot share the split, copy first;
 *   - a `frameUrl` draws the browser frame with that label; the caption sits
 *     under the frame;
 *   - without the visual, the stored picture is not drawn (ADR 0593 §C9).
 *
 * Sabotage witnesses (w96 probes): dropping the image branch, the frame label,
 * the caption or the alt, putting the picture before the copy or the caption
 * above the frame, drawing it without the visual, or blanking the section that
 * keeps the picture stored each reds a case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
const SHOT = { imageToken: 'tok-approval', alt: 'The approval screen', frameUrl: 'Approval · waiting for you', caption: 'Nothing goes out until you say so.' };

describe('richText screenshot (ADR 1074 D1)', () => {
  it('puts the framed screenshot and its caption beside the copy', () => {
    const c = renderSection({ sectionId: 'sec:example', type: 'richText', data: { heading: 'An example', text: 'The essay.', visual: 'image', ...SHOT } });
    const split = c.querySelector('.fp-prose__split')!;
    const copy = split.querySelector('.fp-prose__copy')!;
    expect(copy.querySelector('h2')?.textContent).toBe('An example');
    const fig = split.querySelector('figure.fp-prose__figure')!;
    expect(copy.compareDocumentPosition(fig) & Node.DOCUMENT_POSITION_FOLLOWING, 'copy first').toBeTruthy();
    expect(fig.querySelector('.fp-browser .fp-browser__url')?.textContent).toBe('Approval · waiting for you');
    expect(fig.querySelector('img')?.getAttribute('alt')).toBe('The approval screen');
    const cap = fig.querySelector('figcaption');
    expect(cap?.textContent).toBe('Nothing goes out until you say so.');
    const frame = fig.querySelector('.fp-browser');
    expect(frame, 'the browser frame').not.toBeNull();
    expect(frame!.compareDocumentPosition(cap!) & Node.DOCUMENT_POSITION_FOLLOWING, 'caption under the frame').toBeTruthy();
    expect(fig.querySelector('img')?.getAttribute('src')).toMatch(/\/host\/openwop-app\/assets\/tok-approval$/);
  });

  it('does not draw a stored screenshot without the visual', () => {
    const c = renderSection({ sectionId: 'sec:example', type: 'richText', data: { heading: 'An example', text: 'The essay.', ...SHOT } });
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('.fp-prose__split')).toBeNull();
    // Positive control: the copy still renders, so the absence above is not a blank section.
    expect(c.querySelector('h2')?.textContent).toBe('An example');
    expect(c.querySelector('.fp-prose__body')?.textContent).toBe('The essay.');
  });
});
