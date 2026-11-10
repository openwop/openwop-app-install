/**
 * A seeded public page's content cannot change without its SEED_VERSION.
 *
 * The system site's home page and the features page refresh on a redeploy only
 * when the stored seed marker differs from SEED_VERSION. A content change that
 * forgets the bump reaches fresh installs and never production: ADR 1038's
 * `count: true` stats bands (#5553) and its How-it-works flow (#5582) both
 * shipped that way until a review caught it (2026-11-08).
 *
 * This pins a hash of each page's seeded sections to its version. Changing the
 * content reds it; the fix is to bump that page's SEED_VERSION and re-pin both
 * values here, in the same commit.
 *
 * Sabotage-witnessed (2026-11-08): editing one seeded section without a bump,
 * on either page, turns this red.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SEED_VERSION as SITE_VERSION } from '../src/host/systemSite.js';
import { FEATURE_SECTIONS, SEED_VERSION as FEATURES_VERSION } from '../src/host/featuresPage.js';

const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

describe('seeded page content is versioned', () => {
  it('system site home: content and SEED_VERSION move together', () => {
    expect({ version: SITE_VERSION, content: digest(DEFAULT_SECTIONS) }).toEqual({ version: 10, content: '2c544ad3b5f92a1b' });
  });

  it('features page: content and SEED_VERSION move together', () => {
    expect({ version: FEATURES_VERSION, content: digest(FEATURE_SECTIONS) }).toEqual({ version: 8, content: '81d8738c9e3bc009' });
  });
});
