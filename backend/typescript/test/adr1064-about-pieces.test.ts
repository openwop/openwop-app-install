/**
 * ADR 1064 P3f — validator half of the About pieces: rich text keeps
 * `sources: true`; quotes keep `style: 'pull'`; a `timeline` keeps a picture
 * (alt required, a picture without alt is a 400) and no other layout does.
 * Any other value is dropped. P3f(d): a hero picture keeps up to four chips,
 * each with text and a closed corner (tl/tr/bl/br); a fifth is refused.
 *
 * Sabotage witnesses (grade-tests w92, 11 probes): loosening or dropping
 * `sources`, loosening `style`, keeping a picture off a timeline, dropping the
 * timeline picture or its frame, accepting it without alt, an open chip
 * corner, a chip without text, a fifth chip, or dropping the chips reds a case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { OpenwopError } from '../src/types.js';

const data = (type: string, d: Record<string, unknown>): Record<string, unknown> => validateSection({ type, data: d }).data;
const COLS = [{ title: 'Started', text: 'One app.' }];

describe('About pieces (ADR 1064 P3f)', () => {
  it('keeps sources and the pull style only when exact', () => {
    expect(data('richText', { text: 'x', sources: true }).sources).toBe(true);
    expect(data('richText', { text: 'x', sources: 'yes' }).sources).toBeUndefined();
    expect(data('quotes', { items: [{ quote: 'q' }], style: 'pull' }).style).toBe('pull');
    expect(data('quotes', { items: [{ quote: 'q' }], style: 'big' }).style).toBeUndefined();
  });

  it('keeps a labelled timeline picture, on a timeline only', () => {
    expect(data('columns', { layout: 'timeline', columns: COLS, imageToken: 'med_tl', alt: 'The apps', frameUrl: 'app.example' }))
      .toMatchObject({ imageToken: 'med_tl', alt: 'The apps', frameUrl: 'app.example' });
    expect(data('columns', { layout: 'cards', columns: COLS, imageToken: 'med_tl', alt: 'The apps' }).imageToken).toBeUndefined();
  });

  it('refuses a timeline picture without alt text', () => {
    const bad = (): unknown => data('columns', { layout: 'timeline', columns: COLS, imageToken: 'med_tl' });
    expect(bad).toThrow(OpenwopError);
    expect(bad).toThrow(expect.objectContaining({ httpStatus: 400 }));
    expect(bad).toThrow(/^columns\.alt is required when a timeline has an imageToken\.$/);
  });
});

describe('hero image chips (ADR 1064 P3f d)', () => {
  const hero = (chips: unknown) => validateSection({ type: 'hero', data: { heading: 'About', visual: 'image', imageToken: 'med_face', alt: 'David', chips } }).data;

  it('keeps chips with text and a corner, dropping the rest', () => {
    expect(hero([{ text: 'Four live apps', at: 'tl' }, { text: '', at: 'tr' }, { text: 'One person', at: 'middle' }, { text: 'Live', at: 'br' }]).chips)
      .toEqual([{ text: 'Four live apps', at: 'tl' }, { text: 'Live', at: 'br' }]);
    expect(hero('chips').chips).toBeUndefined();
  });

  it('refuses a fifth chip', () => {
    const bad = (): unknown => hero(Array.from({ length: 5 }, () => ({ text: 'x', at: 'tl' })));
    expect(bad).toThrow(OpenwopError);
    expect(bad).toThrow(expect.objectContaining({ httpStatus: 400 }));
    expect(bad).toThrow(/^hero\.chips holds at most 4 chips\.$/);
  });
});
