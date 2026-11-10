/**
 * ADR 1066 D1/D2 — server half of the hero `placement` and `body` fields.
 *
 *   - `placement` is a closed enum: `below` is kept, anything else (including
 *     the implied default `side`) leaves no key, so a hero that sets none stays
 *     byte-identical;
 *   - `body` is cleaned and capped like the subheading, and reaches the crawler
 *     prerender, the markdown export and the reading-time count.
 *
 * Sabotage witnesses: widening the placement enum, keeping an unknown value,
 * dropping `body` in the validator, in either prerender, or from PROSE_KEYS,
 * raising the 5000 cap, or putting the body before the lede in the prerender
 * reds a case (each witnessed, /grade-tests wave 95).
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';
import { readingMinutesFor } from '../src/features/publishing/publishingService.js';

const OPTS = { assetBase: 'https://app.example.test' };
const hero = (extra: Record<string, unknown>) => validateSection({ type: 'hero', data: { heading: 'Compare the options', visual: 'versus', ...extra } });

describe('hero placement (ADR 1066 D1)', () => {
  it('keeps `below` and nothing else', () => {
    expect(hero({ placement: 'below' }).data.placement).toBe('below');
    expect('placement' in hero({ placement: 'side' }).data).toBe(false);
    expect('placement' in hero({ placement: 'above' }).data).toBe(false);
    expect('placement' in hero({}).data).toBe(false);
  });
});

describe('hero body (ADR 1066 D2)', () => {
  it('is kept, cleaned and capped like the subheading', () => {
    expect(hero({ body: '  We are new: early prices.  ' }).data.body).toBe('We are new: early prices.');
    expect('body' in hero({ body: '   ' }).data).toBe(false);
    expect(hero({ body: 'x'.repeat(6000) }).data.body, 'capped at the subheading\'s 5000').toHaveLength(5000);
  });

  it('reaches the prerender, the markdown export and the reading time', () => {
    const s = hero({ subheading: 'The lede.', body: 'We are new, launching soon.' });
    expect(sectionHtml(s, OPTS)).toContain('<p>The lede.</p>\n<p>We are new, launching soon.</p>');
    expect(sectionMarkdown(s, OPTS.assetBase)).toContain('The lede.\n\nWe are new, launching soon.');
    const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');
    // Literals, counted by hand: the heading is 3 words (max(1, round(3/225)) = 1);
    // with 900 body words it is 903 (round(903/225) = 4).
    expect(readingMinutesFor({ sections: [hero({})] })).toBe(1);
    expect(readingMinutesFor({ sections: [hero({ body: words(900) })] })).toBe(4);
  });
});
