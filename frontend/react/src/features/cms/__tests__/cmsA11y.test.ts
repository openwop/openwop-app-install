/**
 * ADR 0363 P2 — the CMS page → ContentA11yModel projector (`cmsA11y.ts`): image
 * and hero media are projected with their alt, hero/cta CTAs as link text, and
 * a media-less image/hero section is ignored; the shared checker then flags the
 * alt-less image and the generic CTA.
 *
 * Sabotage-witnessed (/grade-tests w17): dropping the `str(d.token)` or
 * `str(d.imageToken)` guard reds case 3; dropping the hero CTA push or the hero
 * alt reds cases 1+2; dropping the cta branch reds case 1.
 */
import { describe, it, expect } from 'vitest';
import { cmsPageToA11yModel, splitA11yRef } from '../cmsA11y.js';
import { checkContentA11y } from '../../../a11y/contentA11y.js';
import type { Section } from '../cmsClient.js';

// `sectionId` is a free-form id, not a SectionType — but defaulting it to `type`
// made TS infer the narrow union, so every real id ('s1', 's2', …) errored. The
// annotation is the fix; the runtime values were always strings.
const sec = (type: Section['type'], data: Record<string, unknown>, sectionId: string = type): Section => ({ sectionId, type, data });

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

  // ADR 1100 D3 — every placement, by field name; sabotage: drop collectNested
  // (red: columns/gallery/hub), drop the hero visual gate (red: the flow case),
  // drop the richText gate (red: the prose case).
  it('finds pictures in list items and nested objects, wherever the renderer reads them', () => {
    const model = cmsPageToA11yModel([
      sec('columns', { columns: [{ title: 'A', imageToken: 'tok:1', alt: 'First' }, { title: 'B', imageToken: 'tok:2' }] }, 'c1'),
      sec('form', { imageToken: 'tok:3', alt: 'Photo', person: { name: 'Ada', imageToken: 'tok:4', alt: '' } }, 'f1'),
    ]);
    // More than one picture in a section → each its own ref, so the panel can say which.
    expect(model.images).toEqual([{ alt: 'First', ref: 'c1#1' }, { alt: '', ref: 'c1#2' }, { alt: 'Photo', ref: 'f1#1' }, { alt: '', ref: 'f1#2' }]);
  });

  it('a hero shows only its own visual: a stale picture token is not checked, the hub centre is', () => {
    const model = cmsPageToA11yModel([
      sec('hero', { visual: 'flow', imageToken: 'tok:stale', heading: 'H' }, 'h1'),
      sec('hero', { visual: 'hub', imageToken: 'tok:stale2', hub: { center: { imageToken: 'tok:hub' } } }, 'h2'),
      sec('hero', { visual: 'image', imageToken: 'tok:shown', alt: 'Shown' }, 'h3'),
    ]);
    expect(model.images).toEqual([{ alt: '', ref: 'h2' }, { alt: 'Shown', ref: 'h3' }]);
  });

  it('an unknown hero visual renders the picture, so it is checked', () => {
    expect(cmsPageToA11yModel([sec('hero', { visual: 'not-a-visual', imageToken: 'tok:x' }, 'h9')]).images).toEqual([{ alt: '', ref: 'h9' }]);
  });

  it('a rich-text picture counts only when its visual is image', () => {
    expect(cmsPageToA11yModel([sec('richText', { text: 't', imageToken: 'tok:x' }, 'r1')]).images).toEqual([]);
    expect(cmsPageToA11yModel([sec('richText', { text: 't', visual: 'image', imageToken: 'tok:x', alt: 'X' }, 'r2')]).images).toEqual([{ alt: 'X', ref: 'r2' }]);
  });

  it('splitA11yRef separates the section from the item', () => {
    expect(splitA11yRef('c1#2')).toEqual({ sectionId: 'c1', item: 2 });
    expect(splitA11yRef('sec:a')).toEqual({ sectionId: 'sec:a' });
  });
});
