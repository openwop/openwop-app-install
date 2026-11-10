/**
 * ADR 1037 — column media on the server: a picture, a browser-frame address
 * and a highlight flag on a `columns` item.
 *
 * Pins:
 *   1. an item keeps an opaque `imageToken` with its `alt`, a plain-text
 *      `frameUrl`, and `highlight: true` (any other highlight value dropped);
 *   2. a picture without alt text is refused, never published unlabelled, and
 *      a frame address without a picture is dropped;
 *   3. caps hold: the alt is cut to 200 characters (MAX.alt) and the address
 *      to 120 (MAX.label), and a token outside the opaque charset is DROPPED
 *      (no picture is kept, so no alt is demanded);
 *   4. an overlay keeps the same rules (no unlabelled picture in a locale);
 *   5. the prerender emits `<img alt loading=lazy>` per item and markdown
 *      `![alt](url)`; an item with none of the new fields renders exactly as
 *      before.
 *
 * Sabotage-witnessed (grade-tests w92, 12 probes): a non-boolean highlight
 * kept, the highlight dropped, the alt refusal removed (base and overlay) or
 * skipped for overlays only, a frame kept without a picture, either cap
 * raised, the token charset check removed, the prerender's alt or a frame
 * label written into the HTML, the markdown alt emptied, and a plain item's
 * HTML changed by the highlight flag each red a case.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };
const data = (type: Section['type'], d: Record<string, unknown>): Record<string, unknown> => validateSection({ type, data: d }).data;
type Col = { imageToken?: string; alt?: string; frameUrl?: string; highlight?: boolean; title?: string };
const colsOf = (d: Record<string, unknown>): Col[] => d.columns as Col[];

describe('ADR 1037 — column item fields', () => {
  it('keeps a picture with its alt, a frame address and a highlight', () => {
    const d = data('columns', { layout: 'bento', columns: [{ title: 'Agents', text: 'T', imageToken: 'tok_shot1', alt: 'The agent role picker', frameUrl: 'myndhyve.ai/agents', highlight: true }] });
    expect(colsOf(d)[0]).toMatchObject({ imageToken: 'tok_shot1', alt: 'The agent role picker', frameUrl: 'myndhyve.ai/agents', highlight: true });
  });
  it('drops a non-boolean highlight', () => {
    const d = data('columns', { layout: 'list', columns: [{ title: 'A', text: 'B', highlight: 'yes' }] });
    expect(colsOf(d)[0]!.highlight).toBeUndefined();
  });
  it('refuses a picture without alt text', () => {
    expect(() => data('columns', { layout: 'marquee', columns: [{ title: 'Acme', text: 'T', imageToken: 'tok_shot1' }] })).toThrow(/alt is required/);
    expect(() => data('columns', { layout: 'marquee', columns: [{ title: 'Acme', text: 'T', imageToken: 'tok_shot1', alt: '   ' }] })).toThrow(/alt is required/);
  });
  it('drops a frame address that has no picture to frame', () => {
    const d = data('columns', { layout: 'bento', columns: [{ title: 'A', text: 'B', frameUrl: 'example.com' }] });
    expect(colsOf(d)[0]!.frameUrl).toBeUndefined();
  });
  it('bounds the alt and the address, and refuses an unsafe token', () => {
    const d = data('columns', { layout: 'bento', columns: [{ title: 'A', text: 'B', imageToken: 'tok_1', alt: 'a'.repeat(500), frameUrl: 'x'.repeat(500) }] });
    expect(colsOf(d)[0]!.alt).toHaveLength(200);
    expect(colsOf(d)[0]!.frameUrl).toHaveLength(120);
    const bad = data('columns', { layout: 'bento', columns: [{ title: 'A', text: 'B', imageToken: 'tok"><script>', alt: 'A' }] });
    expect(colsOf(bad)[0]!.imageToken).toBeUndefined();
  });
  it('holds an overlay to the same rules', () => {
    expect(() => sanitizeSectionOverlay('columns', { columns: [{ title: 'Uno', imageToken: 'tok_1' }] })).toThrow(/alt is required/);
    const o = sanitizeSectionOverlay('columns', { columns: [{ title: 'Uno', text: 'T', imageToken: 'tok_1', alt: 'Uno' }] });
    expect(colsOf(o)[0]).toMatchObject({ imageToken: 'tok_1', alt: 'Uno' });
  });
});

describe('ADR 1037 — crawler output', () => {
  const sec = (columns: Record<string, unknown>[], layout = 'marquee'): Section => validateSection({ sectionId: 's-cols', type: 'columns', data: { layout, columns } });
  it('emits an <img alt> per pictured item', () => {
    const html = sectionHtml(sec([{ title: 'Acme', text: 'A goals app.', imageToken: 'tok_kt', alt: 'Acme home page', frameUrl: 'acme.example' }]), OPTS)!;
    expect(html).toContain('<img src="https://app.example.test/host/openwop-app/assets/tok_kt" alt="Acme home page" loading="lazy">');
    expect(html).not.toContain('acme.example</');
  });
  it('emits ![alt](url) in markdown', () => {
    const md = sectionMarkdown(sec([{ title: 'Acme', text: 'A goals app.', imageToken: 'tok_kt', alt: 'Acme home page' }]), 'https://app.example.test')!;
    expect(md).toContain('![Acme home page](https://app.example.test/host/openwop-app/assets/tok_kt)');
  });
  it('renders an item with none of the new fields exactly as before', () => {
    const plain = sec([{ title: 'A', text: 'B' }], 'bento');
    const withFlag = sec([{ title: 'A', text: 'B', highlight: true }], 'bento');
    expect(sectionHtml(withFlag, OPTS)).toBe(sectionHtml(plain, OPTS));
    expect(sectionHtml(plain, OPTS)).toBe('<section>\n<ul>\n<li><h3>A</h3><p>B</p></li>\n</ul>\n</section>');
    expect(sectionMarkdown(plain, 'https://app.example.test')).toBe('- **A** — B');
  });
});
