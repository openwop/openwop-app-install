import { describe, it, expect } from 'vitest';
import { checkContentA11y, type ContentA11yModel } from '../contentA11y.js';

const empty: ContentA11yModel = { images: [], headings: [], links: [] };

describe('checkContentA11y', () => {
  it('flags a non-decorative image with no alt (1.1.1) and passes alt/decorative', () => {
    expect(checkContentA11y({ ...empty, images: [{ alt: '' }] })).toMatchObject([{ kind: 'missing-alt', severity: 'error', wcag: '1.1.1' }]);
    expect(checkContentA11y({ ...empty, images: [{ alt: 'A cat' }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, images: [{ decorative: true }] })).toEqual([]); // marked decorative
  });

  it('flags skipped heading levels (1.3.1), allows one-step and the base', () => {
    expect(checkContentA11y({ ...empty, headings: [{ level: 1 }, { level: 3 }] })).toMatchObject([{ kind: 'heading-skip', params: { from: 1, to: 3 } }]);
    expect(checkContentA11y({ ...empty, headings: [{ level: 1 }, { level: 2 }, { level: 3 }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, headings: [{ level: 2 }, { level: 3 }] })).toEqual([]); // first sets base
  });

  it('flags empty and generic link text (2.4.4), passes descriptive', () => {
    expect(checkContentA11y({ ...empty, links: [{ text: '' }] })).toMatchObject([{ kind: 'link-text', messageKey: 'linkEmpty' }]);
    expect(checkContentA11y({ ...empty, links: [{ text: 'Click here' }] })).toMatchObject([{ kind: 'link-text', messageKey: 'linkGeneric' }]);
    expect(checkContentA11y({ ...empty, links: [{ text: 'View the Q3 report' }] })).toEqual([]);
  });

  it('flags a low-contrast authored color pair (1.4.3), passes a strong pair', () => {
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#777777', bg: '#808080' }] })).toMatchObject([{ kind: 'low-contrast', severity: 'warning' }]);
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#000000', bg: '#ffffff' }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: 'not-a-color', bg: '#fff' }] })).toEqual([]); // unparseable → skipped, no false positive
  });

  it('aggregates across categories', () => {
    const issues = checkContentA11y({ images: [{ alt: '' }], headings: [{ level: 1 }, { level: 4 }], links: [{ text: 'here' }] });
    expect(issues.map((i) => i.kind).sort()).toEqual(['heading-skip', 'link-text', 'missing-alt']);
  });
});
