/**
 * ADR 0363 P2 — the shared authored-content accessibility checker (`contentA11y.ts`),
 * reused by CMS publish checks, the CMS page panel and the document editor.
 *
 * What breaks it: a non-decorative image with no (or whitespace-only) alt, a skipped
 * heading level, an empty/generic link, or a low-contrast authored pair that is NOT
 * flagged — or a false positive on a decorative image, a heading that steps back up,
 * large text that meets the 3:1 large-text bar, or an unparseable colour.
 *
 * Sabotage-witnessed (/grade-tests w51): dropping the decorative skip, the `prev &&`
 * base guard, the lower-casing, or the contrast check reds its case; the whitespace
 * alt (`norm`), the `large` threshold, the unparseable-BG skip and the step-back-up
 * cases were added in w51 r2 because those breaks stayed green.
 */
import { describe, it, expect } from 'vitest';
import { checkContentA11y, type ContentA11yModel } from '../contentA11y.js';

const empty: ContentA11yModel = { images: [], headings: [], links: [] };

describe('checkContentA11y', () => {
  it('flags a non-decorative image with no alt (1.1.1) and passes alt/decorative', () => {
    expect(checkContentA11y({ ...empty, images: [{ alt: '' }] })).toMatchObject([{ kind: 'missing-alt', severity: 'error', wcag: '1.1.1' }]);
    // Whitespace is not alt text — the checker normalizes before testing.
    expect(checkContentA11y({ ...empty, images: [{ alt: '   ' }] })).toMatchObject([{ kind: 'missing-alt' }]);
    expect(checkContentA11y({ ...empty, images: [{ alt: 'A cat' }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, images: [{ decorative: true }] })).toEqual([]); // marked decorative
  });

  it('flags skipped heading levels (1.3.1), allows one-step and the base', () => {
    expect(checkContentA11y({ ...empty, headings: [{ level: 1 }, { level: 3 }] })).toMatchObject([{ kind: 'heading-skip', params: { from: 1, to: 3 } }]);
    expect(checkContentA11y({ ...empty, headings: [{ level: 1 }, { level: 2 }, { level: 3 }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, headings: [{ level: 2 }, { level: 3 }] })).toEqual([]); // first sets base
    // Stepping back UP any distance (a new section) is never a skip.
    expect(checkContentA11y({ ...empty, headings: [{ level: 1 }, { level: 2 }, { level: 3 }, { level: 1 }] })).toEqual([]);
  });

  it('flags empty and generic link text (2.4.4), passes descriptive', () => {
    expect(checkContentA11y({ ...empty, links: [{ text: '' }] })).toMatchObject([{ kind: 'link-text', messageKey: 'linkEmpty' }]);
    expect(checkContentA11y({ ...empty, links: [{ text: 'Click here' }] })).toMatchObject([{ kind: 'link-text', messageKey: 'linkGeneric', params: { text: 'Click here' } }]);
    expect(checkContentA11y({ ...empty, links: [{ text: 'View the Q3 report' }] })).toEqual([]);
  });

  it('flags a low-contrast authored color pair (1.4.3), passes a strong pair', () => {
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#777777', bg: '#808080' }] })).toMatchObject([{ kind: 'low-contrast', severity: 'warning' }]);
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#000000', bg: '#ffffff' }] })).toEqual([]);
    // #949494 on white is ≈3.03:1 by hand (WCAG: L(#94) = ((0.580+0.055)/1.055)^2.4 ≈ 0.296;
    // 1.05 / 0.346 ≈ 3.03) — below the 4.5 body bar, above the 3.0 large-text bar.
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#949494', bg: '#ffffff' }] })).toMatchObject([{ kind: 'low-contrast' }]);
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#949494', bg: '#ffffff', large: true }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: 'not-a-color', bg: '#fff' }] })).toEqual([]); // unparseable → skipped, no false positive
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#000000', bg: 'not-a-color' }] })).toEqual([]); // either side
  });

  it('aggregates across categories', () => {
    const issues = checkContentA11y({ images: [{ alt: '' }], headings: [{ level: 1 }, { level: 4 }], links: [{ text: 'here' }] });
    expect(issues.map((i) => i.kind).sort()).toEqual(['heading-skip', 'link-text', 'missing-alt']);
  });
});
