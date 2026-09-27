/**
 * UX_UPGRADE-site R2-G10 — the `faq` and `quotes` CMS section types.
 *
 * Three layers, each from the SAME validated data:
 * 1. `validateSection` — closed-field validation: bounds, plain-text coercion,
 *    required-item failures on full validation, unattributed quotes allowed.
 * 2. `sectionHtml` — the crawler prerender emits semantic <details>/<summary>
 *    and <figure>/<blockquote> markup.
 * 3. `jsonLdBlocks` — a page holding `faq` sections emits ONE FAQPage block
 *    built from those items (the ADR 0384 deferral trigger, now fired) — and a
 *    page WITHOUT one emits none (never fabricated).
 */
import { describe, expect, it } from 'vitest';
import { validateSection, type SectionType, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml, type SectionHtmlOptions } from '../src/features/publishing/sectionHtml.js';
import { jsonLdBlocks } from '../src/features/publishing/prerenderService.js';

const data = (raw: object): Record<string, unknown> => validateSection(raw).data;

describe('faq section — validation', () => {
  it('keeps bounded Q/A pairs and drops half-empty ones', () => {
    const d = data({ type: 'faq', data: {
      heading: 'FAQ',
      items: [
        { q: 'How is pricing calculated?', a: 'Per workspace.' },
        { q: 'Half empty', a: '' },
        { q: '', a: 'orphan answer' },
      ],
    } });
    expect(d.items).toEqual([{ q: 'How is pricing calculated?', a: 'Per workspace.' }]);
  });

  it('rejects an item-less faq on full validation', () => {
    expect(() => validateSection({ type: 'faq', data: { items: [] } })).toThrow(/at least one question/);
    expect(() => validateSection({ type: 'faq', data: { items: [{ q: 'q only' }] } })).toThrow(/at least one question/);
  });

  it('caps the item count and coerces non-string fields to empty (then drops)', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ q: `Q${i}`, a: `A${i}` }));
    const d = data({ type: 'faq', data: { items } });
    expect((d.items as unknown[]).length).toBe(20);
    const bad = data({ type: 'faq', data: { items: [{ q: { evil: true }, a: 'x' }, { q: 'ok', a: 'fine' }] } });
    expect(bad.items).toEqual([{ q: 'ok', a: 'fine' }]);
  });

  it('is a registered section type (compile-time union guard; runtime via validateSection not throwing above)', () => {
    // The union assignment is the real (compile-time) assertion; the runtime
    // registry membership is covered by every happy-path test in this file.
    const t: SectionType = 'faq';
    expect(t).toBe('faq');
  });
});

describe('quotes section — validation', () => {
  it('keeps attributed quotes and allows unattributed ones (no invented byline)', () => {
    const d = data({ type: 'quotes', data: {
      items: [
        { quote: 'It shipped our launch.', name: 'Ana', role: 'CTO, Acme' },
        { quote: 'Unattributed but real.' },
        { quote: '' },
      ],
    } });
    expect(d.items).toEqual([
      { quote: 'It shipped our launch.', name: 'Ana', role: 'CTO, Acme' },
      { quote: 'Unattributed but real.' },
    ]);
  });

  it('rejects an item-less quotes section on full validation', () => {
    expect(() => validateSection({ type: 'quotes', data: { items: [] } })).toThrow(/at least one quote/);
  });
});

describe('prerender HTML — semantic markup from the same data', () => {
  const opts: SectionHtmlOptions = { assetBase: '' };

  it('faq renders <details>/<summary> per pair, escaped', () => {
    const s: Section = validateSection({ type: 'faq', data: { heading: 'FAQ', items: [{ q: 'A <q>?', a: 'An & answer.' }] } });
    const html = sectionHtml(s, opts)!;
    expect(html).toContain('<details><summary>A &lt;q&gt;?</summary><p>An &amp; answer.</p></details>');
  });

  it('quotes renders <figure>/<blockquote>, byline only when authored', () => {
    const s: Section = validateSection({ type: 'quotes', data: { items: [
      { quote: 'Great.', name: 'Ana', role: 'CTO' },
      { quote: 'Anonymous praise.' },
    ] } });
    const html = sectionHtml(s, opts)!;
    expect(html).toContain('<blockquote><p>Great.</p></blockquote><figcaption>Ana, CTO</figcaption>');
    expect(html).toContain('<blockquote><p>Anonymous praise.</p></blockquote></figure>');
  });
});

describe('FAQPage JSON-LD — emitted only from typed faq sections', () => {
  const seo = { title: 'T', description: 'D', canonicalUrl: 'https://x.test/p/t', ogTitle: 'T', ogDescription: '', noindex: false };
  const base = { seo, locale: 'en', baseUrl: 'https://x.test' };

  it('a page with a faq section emits one FAQPage block from its items', () => {
    const faq: Section = validateSection({ type: 'faq', data: { items: [{ q: 'Q1', a: 'A1' }, { q: 'Q2', a: 'A2' }] } });
    const blocks = jsonLdBlocks({ ...base, page: { title: 'T', updatedAt: '', slug: 't', sections: [faq] } });
    const faqBlock = blocks.find((b) => (b as { '@type'?: string })['@type'] === 'FAQPage') as { mainEntity: unknown[] } | undefined;
    expect(faqBlock).toBeTruthy();
    expect(faqBlock!.mainEntity).toEqual([
      { '@type': 'Question', name: 'Q1', acceptedAnswer: { '@type': 'Answer', text: 'A1' } },
      { '@type': 'Question', name: 'Q2', acceptedAnswer: { '@type': 'Answer', text: 'A2' } },
    ]);
  });

  it('a page without a faq section emits NO FAQPage block (never fabricated)', () => {
    const hero: Section = validateSection({ type: 'hero', data: { heading: 'H' } });
    const blocks = jsonLdBlocks({ ...base, page: { title: 'T', updatedAt: '', slug: 't', sections: [hero] } });
    expect(blocks.some((b) => (b as { '@type'?: string })['@type'] === 'FAQPage')).toBe(false);
  });
});
