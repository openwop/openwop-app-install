/**
 * ADR 1038 P3 — a stats band's figures can count up.
 *
 *   1. `count` is a base-layer presentation flag kept only on a `columns` section
 *      whose layout is `stats`, and only as literal `true`; another layout drops a
 *      leftover, and a locale overlay never carries it.
 *   2. Crawlers read the stats band's heading and lede above the figures (they
 *      were missing before P3), and the figures as written, never a counter.
 *
 * The overlay fixture carries `layout: 'stats'` (asserted kept), so the
 * partial-build guard (`if (partial || …) return data;`) is the only thing that
 * drops `count` there; without the layout the layout gate would drop it too and
 * the overlay case could not fail (w87 probe p3-overlay read vacuous on exactly
 * that). `type === 'columns'` beside `data.layout === 'stats'` is an equivalent
 * mutant: only the `columns` builder stores `layout`, so the richText line is a
 * control, not a witness of the type check (w87 p3-type-gate, recorded).
 *
 * Sabotage-witnessed (w87 probes): dropping the layout gate or the literal-`true`
 * check reds 1; removing `head()`, the lede, or adding a counter class to the
 * figures in the stats branch of `sectionHtml` reds 2; keeping `count` on a
 * partial (overlay) build reds 1 (re-probed after the fixture fix).
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';

const columns = [{ title: '130', text: 'teams' }, { title: '24/7', text: 'support' }];
const data = (extra: Record<string, unknown>) => validateSection({ type: 'columns', data: { columns, ...extra } }).data;

describe('stats count', () => {
  it('is kept only on a stats layout, only as true', () => {
    expect(data({ layout: 'stats', count: true }).count).toBe(true);
    expect('count' in data({ layout: 'stats', count: 'yes' })).toBe(false);
    expect('count' in data({ layout: 'cards', count: true })).toBe(false);
    expect('count' in validateSection({ type: 'richText', data: { body: 'x', count: true } }).data).toBe(false);
  });

  it('never rides a locale overlay', () => {
    const overlay = sanitizeSectionOverlay('columns', { layout: 'stats', columns, count: true });
    // Positive control: the overlay keeps the layout, so only the partial guard can drop `count`.
    expect(overlay.layout).toBe('stats');
    expect('count' in overlay).toBe(false);
  });
});

describe('the stats crawler', () => {
  it('reads the heading and lede, then the figures as written', () => {
    const s = validateSection({ type: 'columns', data: { layout: 'stats', heading: 'By the numbers', lede: 'This *year*', columns, count: true } });
    const html = sectionHtml(s, { assetBase: 'https://app.example.test' })!;
    expect(html).toMatch(/<h2[^>]*>By the numbers<\/h2>\n<p>This <em>year<\/em><\/p>\n<dl>\n<div><dt>130<\/dt><dd>teams<\/dd><\/div>/);
    expect(html).not.toContain('fp-count');
  });
});
