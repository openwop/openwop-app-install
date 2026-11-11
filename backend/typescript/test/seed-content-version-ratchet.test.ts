/**
 * A seeded public page's content cannot change without its SEED_VERSION.
 *
 * Every seeded system-site page (home, features, comparison, the marketing
 * content pages, the docs corpus and the launch blog post) refreshes on a
 * redeploy only when the stored seed marker differs from SEED_VERSION. A content change that
 * forgets the bump reaches fresh installs and never production: ADR 1038's
 * `count: true` stats bands (#5553) and its How-it-works flow (#5582) both
 * shipped that way until a review caught it (2026-11-08).
 *
 * This pins a hash of each seed's content to its version. Changing the
 * content reds it; the fix is to bump that page's SEED_VERSION and re-pin both
 * values here, in the same commit.
 *
 * Sabotage-witnessed (2026-11-08): editing one seeded section without a bump,
 * on either page, turns this red. Extended to the other four seeds on
 * 2026-11-09, when grading #5582 found they had the same hole. Tutorials carry
 * a `seedVersion` per tutorial instead, so each one is pinned on its own
 * (SEED-2, 2026-11-10).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SEED_VERSION as SITE_VERSION } from '../src/host/systemSite.js';
import { FEATURE_SECTIONS, SEED_VERSION as FEATURES_VERSION } from '../src/host/featuresPage.js';
import { COMPARISON_SECTIONS, SEED_VERSION as COMPARISON_VERSION } from '../src/host/comparisonPage.js';
import { MARKETING_CONTENT_PAGE_SPECS, SEED_VERSION as MARKETING_VERSION } from '../src/host/marketingContentPages.js';
import { DOCS, SEED_VERSION as DOCS_VERSION } from '../src/host/systemSiteDocs.js';
import { seededPostContent, SEED_VERSION as BLOG_VERSION } from '../src/host/systemSiteBlog.js';
import { SEED_TUTORIALS } from '../src/features/tutorials/seedTutorials.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

describe('seeded page content is versioned', () => {
  it('system site home: content and SEED_VERSION move together', () => {
    expect({ version: SITE_VERSION, content: digest(DEFAULT_SECTIONS) }).toEqual({ version: 10, content: '2c544ad3b5f92a1b' });
  });

  it('features page: content and SEED_VERSION move together', () => {
    expect({ version: FEATURES_VERSION, content: digest(FEATURE_SECTIONS) }).toEqual({ version: 8, content: '81d8738c9e3bc009' });
  });

  it('comparison page: content and SEED_VERSION move together', () => {
    expect({ version: COMPARISON_VERSION, content: digest(COMPARISON_SECTIONS) }).toEqual({ version: 1, content: 'd2499e7f29cae2a5' });
  });

  it('marketing content pages: content and SEED_VERSION move together', () => {
    expect({ version: MARKETING_VERSION, content: digest(MARKETING_CONTENT_PAGE_SPECS) }).toEqual({ version: 6, content: '8e65e6d1a6285a66' });
  });

  it('docs corpus: content and SEED_VERSION move together', () => {
    expect({ version: DOCS_VERSION, content: digest(DOCS) }).toEqual({ version: 1, content: '3bc70aa3f533f75b' });
  });

  it('every seed version in src is pinned in this file', () => {
    // A new seed would otherwise escape this file the way four did until 2026-11-09.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
    const declaring = walk(SRC)
      .filter((f) => /^(export )?const SEED_VERSION = /m.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
      .sort();
    expect(declaring).toEqual([
      'host/comparisonPage.ts', 'host/featuresPage.ts', 'host/marketingContentPages.ts',
      'host/systemSite.ts', 'host/systemSiteBlog.ts', 'host/systemSiteDocs.ts',
    ]);
    // Seeds that version each item instead (a `seedVersion: '1.0.0'` literal) are pinned per item below.
    const perItem = walk(SRC)
      .filter((f) => /["']?seedVersion["']?: *["'][0-9]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(perItem).toEqual(['features/tutorials/seedTutorials.ts']);
  });

  it('launch blog post: content and SEED_VERSION move together', () => {
    expect({ version: BLOG_VERSION, content: digest(seededPostContent()) }).toEqual({ version: 2, content: '5372eec15cfd5b15' });
  });

  it('tutorials: each tutorial and its seedVersion move together', () => {
    // Each seeded tutorial refreshes when its own seedVersion changes (tutorialsService.ts:245).
    // A new tutorial reds this too, so it gets a pin when it lands.
    const pins = Object.fromEntries(SEED_TUTORIALS.map(({ seedVersion, ...content }) => [content.id, { seedVersion, content: digest(content) }]));
    expect(pins).toEqual({
      'connect-your-ai': { seedVersion: '1.5.0', content: '68f6ec9b1b9638fc' },
      'campaign-studio-first-brief': { seedVersion: '1.5.0', content: 'def0e25ce08f77a5' },
      'build-your-first-funnel': { seedVersion: '1.5.0', content: '37d7f3d32282b15b' },
      'open-your-storefront': { seedVersion: '1.5.0', content: '30ebee72f6e23dd2' },
      'model-your-first-part': { seedVersion: '1.1.0', content: 'b7837c4229e2205e' },
      'set-up-claude-code': { seedVersion: '1.1.0', content: 'c07e887aeed039cf' },
    });
  });
});
