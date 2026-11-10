/**
 * ADR 1068 D3 (myndhyve.ai design batch, P3d-3): the server half.
 *
 *  1. `headSize: 'sm'` is a closed enum beside `head` (unknown values dropped).
 *  2. (The column call to action is f2's `ctaLabel`/`ctaUrl` from #5660, validated
 *     there; P3d-3 only draws it as an action line in panels/cards.)
 *  3. A form card's `note` is kept on the card layout and carried by an overlay
 *     (which names no layout); a plain form drops it.
 *  4. The column call to action and the note reach the crawler and the markdown.
 *
 * Sabotage (each witnessed red, w96): accept any headSize; drop the form note, or
 * keep it on a plain form, or drop it from an overlay; drop the note or the column
 * call to action from the crawler or the markdown. The column call-to-action lines
 * share the columns branch with adr1069-plan-cards (layout `list`); this file is
 * the only one that pins it on the D3 panels layout.
 */
import { describe, expect, it } from 'vitest';
import { validateSection, sanitizeSectionOverlay } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const COLS = (columns: unknown[], extra: Record<string, unknown> = {}) =>
  validateSection({ type: 'columns', data: { layout: 'panels', heading: 'Who it is for', columns, ...extra } });

describe('headSize', () => {
  it("keeps 'sm' and drops anything else", () => {
    expect(COLS([{ title: 'A', text: 'a' }], { headSize: 'sm' }).data.headSize).toBe('sm');
    expect('headSize' in COLS([{ title: 'A', text: 'a' }], { headSize: 'huge' }).data).toBe(false);
  });
});

describe('form card note', () => {
  const form = (d: Record<string, unknown>) => validateSection({ type: 'form', data: { formId: 'form:abc', heading: 'Tell us', ...d } }).data;

  it('is kept on the card layout, dropped on a plain form, carried by an overlay', () => {
    expect(form({ layout: 'card', note: 'Read by a person.' }).note).toBe('Read by a person.');
    expect(form({ note: 'Read by a person.' }).note).toBeUndefined();
    expect(sanitizeSectionOverlay('form', { note: 'Lido por uma pessoa.' }).note).toBe('Lido por uma pessoa.');
  });
});

describe('crawler and markdown', () => {
  it('render the column call to action and the form note', () => {
    const s = COLS([{ title: 'Agencies', text: 'Print an app per client.', ctaLabel: 'For agencies', ctaUrl: '/p/agencies' }]);
    const html = sectionHtml(s, { assetBase: 'https://app.example.test' })!;
    expect(html).toContain('<p><a href="/p/agencies">For agencies</a></p>');
    expect(sectionMarkdown(s, 'https://app.example.test')!).toContain('[For agencies](/p/agencies)');
    const f = validateSection({ type: 'form', data: { formId: 'form:abc', heading: 'Tell us', layout: 'card', note: 'Read by a person.' } });
    expect(sectionHtml(f, { assetBase: 'https://app.example.test' })!).toContain('<p>Read by a person.</p>');
    expect(sectionMarkdown(f, 'https://app.example.test')!).toContain('Read by a person.');
  });
});
