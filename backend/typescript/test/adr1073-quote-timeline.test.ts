/**
 * ADR 1073 — server half of the richText pull quote and the timeline options.
 *
 *   - D1: richText keeps `quote` (plain, capped); crawlers read it as a
 *     blockquote before the essay, and markdown as a `>` line;
 *   - D2/D3: `shotSide` {start} and `markers` {badge} are closed sets kept on a
 *     timeline only.
 *
 * Sabotage witnesses: dropping the quote in the validator or either prerender,
 * widening either set, or keeping either option off a timeline reds a case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };

describe('pull quote (ADR 1073 D1)', () => {
  it('keeps the quote and reads it before the essay', () => {
    const s = validateSection({ type: 'richText', data: { heading: 'The one-person company', quote: '  Small teams do big work.  ', text: 'The essay.' } });
    expect(s.data.quote).toBe('Small teams do big work.');
    expect(sectionHtml(s, OPTS)).toMatch(/<blockquote><p>Small teams do big work\.<\/p><\/blockquote>\n<p>The essay\.<\/p>/);
    expect(sectionMarkdown(s, OPTS.assetBase)).toContain('> Small teams do big work.\n\nThe essay.');
  });
});

describe('timeline options (ADR 1073 D2/D3)', () => {
  const tl = (layout: string, extra: Record<string, unknown>) => validateSection({ type: 'columns', data: { layout, columns: [{ title: 'A', text: 'a' }], ...extra } }).data;

  it('keeps start side and badges on a timeline only, nothing outside their sets', () => {
    expect(tl('timeline', { shotSide: 'start', markers: 'badge' })).toMatchObject({ shotSide: 'start', markers: 'badge' });
    expect('shotSide' in tl('timeline', { shotSide: 'end' })).toBe(false);
    expect('markers' in tl('timeline', { markers: 'star' })).toBe(false);
    const cards = tl('cards', { shotSide: 'start', markers: 'badge' });
    expect('shotSide' in cards || 'markers' in cards).toBe(false);
  });
});
