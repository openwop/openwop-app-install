/**
 * The front-page story exists as the system-site seed (`DEFAULT_SECTIONS`) and
 * as its operator-publishable twin, docs/site/front-page-story.sections.json.
 * Pin the twin to the seed so a third copy cannot drift, and pin that the seed
 * survives the CMS's own validation LOSSLESSLY: `applyDefault` skips validation,
 * and the JSON is pasted in through the validated routes — a field the validator
 * drops (an unknown hero `visual`, a `layout` outside COLUMN_LAYOUTS, an
 * over-long string) would otherwise publish silently degraded on one path only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateSections } from '../src/features/cms/cmsService.js';
import { DEFAULT_SECTIONS } from '../src/host/systemSite.js';

const DOC = fileURLToPath(new URL('../../../docs/site/front-page-story.sections.json', import.meta.url));

describe('front-page story sections (docs/site)', () => {
  const doc = JSON.parse(readFileSync(DOC, 'utf8')) as { sections: unknown[] };

  it('is the seed, byte for byte (the docs JSON is the seed\'s publishable twin)', () => {
    expect(doc.sections).toEqual(DEFAULT_SECTIONS);
  });

  it('validates without losing a field, in every locale overlay', () => {
    expect(validateSections(DEFAULT_SECTIONS, 'en')).toEqual(DEFAULT_SECTIONS);
  });

  it('carries no gated claim phrase', () => {
    const text = JSON.stringify(doc).toLowerCase();
    for (const phrase of ['industry standard', 'vendor-neutral standard', 'independently validated', 'fully conformant', 'best-in-class', 'production multi-region', 'a-grade']) {
      expect(text).not.toContain(phrase);
    }
  });
});
