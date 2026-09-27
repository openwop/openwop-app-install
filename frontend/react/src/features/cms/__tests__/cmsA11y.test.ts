import { describe, it, expect } from 'vitest';
import { cmsPageToA11yModel } from '../cmsA11y.js';
import { checkContentA11y } from '../../../a11y/contentA11y.js';
import type { Section } from '../cmsClient.js';

// `sectionId` is a free-form id, not a SectionType — but defaulting it to `type`
// made TS infer the narrow union, so every real id ('s1', 's2', …) errored. The
// annotation is the fix; the runtime values were always strings.
const sec = (type: Section['type'], data: Record<string, unknown>, sectionId: string = type): Section => ({ sectionId, type, data } as Section);

describe('cmsPageToA11yModel', () => {
  it('projects image + hero images (with alt) and hero/cta link text; no headings/colors', () => {
    const model = cmsPageToA11yModel([
      sec('image', { token: 'tok:a', alt: '' }, 's1'),
      sec('hero', { imageToken: 'tok:b', alt: 'A banner', ctaUrl: '/buy', ctaLabel: 'Click here' }, 's2'),
      sec('cta', { url: '/go', label: 'Start your free trial' }, 's3'),
      sec('richText', { text: 'ignored' }, 's4'),
    ]);
    expect(model.headings).toEqual([]);
    expect(model.colorPairs).toBeUndefined();
    expect(model.images).toEqual([{ alt: '', ref: 's1' }, { alt: 'A banner', ref: 's2' }]);
    expect(model.links).toEqual([{ text: 'Click here', ref: 's2' }, { text: 'Start your free trial', ref: 's3' }]);
  });

  it('feeds the shared checker: flags the alt-less image + generic hero CTA, passes the good cta', () => {
    const issues = checkContentA11y(cmsPageToA11yModel([
      sec('image', { token: 'tok:a' }, 's1'), // no alt → missing-alt
      sec('hero', { imageToken: 'tok:b', alt: 'ok', ctaUrl: '/x', ctaLabel: 'here' }, 's2'), // generic link
      sec('cta', { url: '/go', label: 'Start your free trial' }, 's3'), // descriptive → clean
    ]));
    expect(issues.map((i) => i.kind).sort()).toEqual(['link-text', 'missing-alt']);
  });

  it('ignores an image/hero section with no media token', () => {
    expect(cmsPageToA11yModel([sec('image', { alt: 'x' }), sec('hero', { heading: 'H' })]).images).toEqual([]);
  });
});
