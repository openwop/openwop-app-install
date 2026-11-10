/**
 * ADR 1070 — server half of the bento and card options.
 *
 *   - `tall` (true only), `tone` in {inverse, mist}, `countLabel` (capped
 *     content) and `imagePosition: 'top'` are kept; anything else is dropped;
 *   - a labelled headline number reads as its words for crawlers, in the
 *     prerender and the markdown export; an unlabelled count adds nothing (as
 *     before).
 *
 * Sabotage witnesses: widening the tone set, keeping `tall` for a non-boolean,
 * dropping `countLabel` or `imagePosition`, lifting the 40-character
 * `countLabel` cap (`MAX.badge`), or dropping the stat line from
 * either prerender (or writing it without a label) reds a case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };
const bento = (columns: Record<string, unknown>[]) => validateSection({ type: 'columns', data: { layout: 'bento', columns } });

describe('bento and card options (ADR 1070)', () => {
  it('keeps the closed options and drops the rest', () => {
    const cols = bento([
      { title: 'A', tall: true, tone: 'mist', count: 130, countLabel: 'features, already built', imagePosition: 'top' },
      { title: 'B', tall: 'yes', tone: 'neon', imagePosition: 'left' },
      { title: 'C', tone: 'inverse' },
      { title: 'D', count: 3, countLabel: 'tools your team already uses every single day' },
    ]).data.columns as Record<string, unknown>[];
    expect(cols[0]).toMatchObject({ tall: true, tone: 'mist', count: 130, countLabel: 'features, already built', imagePosition: 'top' });
    expect(cols[1]).toEqual({ title: 'B', text: '' });
    expect(cols[2]!.tone).toBe('inverse');
    // 45 characters in, cut to the 40-character content cap.
    expect(cols[3]!.countLabel).toBe('tools your team already uses every singl');
  });

  it('reads a labelled number as its words, and adds nothing for an unlabelled one', () => {
    const s = bento([{ title: 'Built', text: 'Ready.', count: 130, countLabel: 'features, already built' }, { title: 'Old', text: 'x', count: 7 }]);
    const html = sectionHtml(s, OPTS);
    expect(html).toContain('<p>Ready.</p><p>130 features, already built</p>');
    expect(html).not.toContain('<p>7');
    const md = sectionMarkdown(s, OPTS.assetBase);
    expect(md).toContain('**Built** — Ready.\n   130 features, already built');
    expect(md).not.toMatch(/\n {3}7\b/);
  });
});
