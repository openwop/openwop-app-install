/**
 * ADR 1063 — server half of the P2a section additions:
 *
 *   - D2 `faq` keeps `columns: 2` (any other value is dropped), `openFirst: true`,
 *     and an optional picture (`imageToken` + required `alt`, optional
 *     `frameUrl`); a picture without alt is a 400;
 *   - D3 `columns` accepts `layout: 'incidents'`, and the prerendered HTML and
 *     the markdown export treat it as an ordered list that leads with each
 *     item's time (its `eyebrow`), like a timeline.
 *
 * P2d: `columns` accepts `layout: 'board'`; the prerender keeps every lane's
 * items (a board is titled lists, like the cards fallback). P2e: it accepts
 * `layout: 'gallery'`. A gallery picture still needs its alt text: that rule is
 * layout-agnostic and is asserted by adr1037-cms-column-media › "refuses a
 * picture without alt text" (the same throw; grade-tests w92 cut the copy here).
 *
 * Sabotage witnesses (grade-tests w92, 17 probes): loosening or dropping a faq
 * key, accepting a picture with no alt, removing 'incidents', 'board' or
 * 'gallery' from COLUMN_LAYOUTS, leaving incidents out of either prerender's
 * ordered branch or its time lead, dropping a lane's flag or item meta, or a
 * board branch that drops its items reds a case. A faq frame without a picture
 * is dropped by TWO guards in cmsService (the `faqFrame` ternary and the
 * `faqImage ?` spread); only an edit that breaks both reds it.
 */
import { describe, expect, it } from 'vitest';
import { validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';
import { OpenwopError } from '../src/types.js';

const OPTS = { assetBase: 'https://app.example.test' };
const sec = (type: Section['type'], d: Record<string, unknown>): Section => validateSection({ sectionId: `s-${type}`, type, data: d });
const ITEMS = [{ q: 'Is it free?', a: 'Yes.' }, { q: 'Who reads it?', a: 'A person.' }];

describe('faq columns, openFirst and picture (ADR 1063 D2)', () => {
  it('keeps columns 2, openFirst and a labelled picture', () => {
    expect(sec('faq', { items: ITEMS, columns: 2, openFirst: true, imageToken: 'med_abc', alt: 'Admin overview', frameUrl: 'app.example/admin' }).data)
      .toMatchObject({ columns: 2, openFirst: true, imageToken: 'med_abc', alt: 'Admin overview', frameUrl: 'app.example/admin' });
  });

  it('drops any other columns value, a non-true openFirst, and a frame with no picture', () => {
    const d = sec('faq', { items: ITEMS, columns: 3, openFirst: 'yes', frameUrl: 'x' }).data;
    expect(d.columns).toBeUndefined();
    expect(d.openFirst).toBeUndefined();
    expect(d.frameUrl).toBeUndefined();
    expect(sec('faq', { items: ITEMS, columns: '2' }).data.columns).toBeUndefined();
  });

  it('refuses a picture with no alt text', () => {
    const bad = (): unknown => sec('faq', { items: ITEMS, imageToken: 'med_abc' });
    expect(bad).toThrow(OpenwopError);
    expect(bad).toThrow(expect.objectContaining({ httpStatus: 400 }));
    expect(bad).toThrow(/^faq\.alt is required when faq\.imageToken is set\.$/);
  });
});

describe('columns incidents layout (ADR 1063 D3)', () => {
  const incidents = sec('columns', {
    heading: 'On Tuesday',
    layout: 'incidents',
    columns: [
      { eyebrow: 'TUE 09:12 · FOLLOW-UP AGENT', text: 'Sent a follow-up to someone who had said no.', icon: 'mail' },
      { eyebrow: 'TUE 11:40 · BILLING AGENT', text: 'Charged a card twice.' },
    ],
  });

  it('is an accepted layout', () => {
    expect(incidents.data.layout).toBe('incidents');
  });

  it('prerenders as an ordered list led by each time', () => {
    const html = sectionHtml(incidents, OPTS) ?? '';
    expect(html).toContain('<ol>');
    expect(html).toContain('<li><p>TUE 09:12 · FOLLOW-UP AGENT</p><p>Sent a follow-up to someone who had said no.</p></li>');
    const md = sectionMarkdown(incidents, OPTS.assetBase) ?? '';
    expect(md).toMatch(/^1\. \*TUE 09:12 · FOLLOW-UP AGENT\* /m);
    expect(md).toMatch(/^2\. \*TUE 11:40 · BILLING AGENT\* /m);
  });
});

describe('columns board layout (ADR 1063 P2d)', () => {
  const board = sec('columns', {
    heading: 'Works today, partly there, not yet',
    layout: 'board',
    columns: [
      { title: 'Works today', items: [{ label: 'Steps that wait for your OK' }] },
      { title: 'Not yet', future: true, items: [{ label: 'An outside security audit', meta: 'Planned' }] },
    ],
  });

  it('is an accepted layout that keeps its lanes, flags and items', () => {
    expect(board.data.layout).toBe('board');
    expect(board.data.columns).toEqual([
      { title: 'Works today', text: '', items: [{ label: 'Steps that wait for your OK' }] },
      { title: 'Not yet', text: '', future: true, items: [{ label: 'An outside security audit', meta: 'Planned' }] },
    ]);
  });

  it('prerenders every lane and its items', () => {
    const html = sectionHtml(board, OPTS) ?? '';
    expect(html).toContain('Works today');
    expect(html).toContain('Steps that wait for your OK');
    expect(html).toContain('An outside security audit');
    const md = sectionMarkdown(board, OPTS.assetBase) ?? '';
    expect(md).toContain('An outside security audit (Planned)');
  });
});

describe('columns gallery layout (ADR 1063 P2e)', () => {
  it('is an accepted layout that keeps each picture with its alt text and frame', () => {
    const g = sec('columns', { layout: 'gallery', columns: [{ title: 'Builder', imageToken: 'med_a', alt: 'The builder', frameUrl: 'app.example/b' }] });
    expect(g.data.layout).toBe('gallery');
    expect((g.data.columns as Array<Record<string, unknown>>)[0]).toMatchObject({ imageToken: 'med_a', alt: 'The builder', frameUrl: 'app.example/b' });
  });
});
