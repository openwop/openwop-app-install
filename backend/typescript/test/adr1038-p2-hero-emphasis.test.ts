/**
 * ADR 1038 P2 — the hero heading's marked words can be struck through,
 * underlined or highlighted.
 *
 *   1. `emphasis` is a closed, hero-only presentation enum on the BASE layer:
 *      junk and other section types drop it, and a locale overlay never carries it
 *      (a translated heading keeps the base page's style).
 *   2. Crawlers read the same words and the same meaning: the marked run is
 *      `<em>`, and for `strike` it is `<em><s>…</s></em>` (markdown `~~…~~`), so a
 *      struck word is never read as its opposite; no style class reaches them.
 *
 * Sabotage-witnessed (w87 probes): an open enum, emphasis on another section
 * type, or keeping `emphasis` on an overlay build reds 1; no `<s>`, `<s>` for
 * every style, the style as a class in the crawler hero, no `~~` in markdown,
 * and `~~` for a non-strike style in markdown (asserted after w87) red 2.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

describe('hero emphasis', () => {
  it('is a closed enum on the hero base layer only', () => {
    const hero = (emphasis: unknown) => validateSection({ type: 'hero', data: { heading: 'Taking *months.*', emphasis } }).data;
    for (const e of ['accent', 'strike', 'underline', 'highlight']) expect(hero(e).emphasis).toBe(e);
    expect('emphasis' in hero('blink')).toBe(false);
    expect('emphasis' in validateSection({ type: 'cta', data: { heading: 'H', label: 'Go', url: '/go', emphasis: 'strike' } }).data).toBe(false);
    expect('emphasis' in sanitizeSectionOverlay('hero', { heading: 'Tomando *meses.*', emphasis: 'strike' })).toBe(false);
  });

  it('reaches crawlers as <em> words, never as a style', () => {
    const s = validateSection({ type: 'hero', data: { heading: 'The business is taking *months.*', emphasis: 'strike' } });
    const html = sectionHtml(s, { assetBase: 'https://app.example.test' })!;
    expect(html).toContain('<h1>The business is taking <em><s>months.</s></em></h1>');
    expect(html).not.toMatch(/strike|fp-em--/);
    expect(sectionMarkdown(s, 'https://app.example.test')!).toContain('The business is taking ~~months.~~');
    // Other styles keep the plain emphasis.
    const u = validateSection({ type: 'hero', data: { heading: 'Ship *it*', emphasis: 'underline' } });
    expect(sectionHtml(u, { assetBase: 'https://app.example.test' })).toContain('<h1>Ship <em>it</em></h1>');
    const md = sectionMarkdown(u, 'https://app.example.test')!;
    expect(md).toContain('## Ship *it*');
    expect(md).not.toContain('~~');
  });
});
