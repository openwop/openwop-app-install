/**
 * The generic 'Business Tools' catch-all category was eliminated across the four
 * grouping passes (CDP → CRM/Studio → Sales/Commerce → residual; see
 * `cdp-feature-grouping.test.ts` and `crm-studio-grouping.test.ts` for the
 * passes, and GRP-1 for the funnels coupling): every feature now sits in a domain
 * category (CRM/Sales/Commerce/Marketing/CDP/Studio/Chat/Agents/Content/
 * Leadership/Platform/...). This locks that — a new feature that lazily reaches
 * for 'Business Tools', or declares no category, fails here and the feature-
 * toggle admin would otherwise file it under a meaningless bucket.
 */
import { describe, it, expect } from 'vitest';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { funnelsFeature } from '../src/features/funnels/feature.js';
describe('feature-toggle categories — no generic catch-all', () => {
  it('no registered feature uses the retired "Business Tools" category', () => {
    const offenders = BACKEND_FEATURES.filter(
      (f) => f.toggleDefault?.category === 'Business Tools',
    ).map((f) => f.toggleDefault?.id);
    expect(offenders).toEqual([]);
  });

  it('every feature with a toggle declares a category', () => {
    const uncategorized = BACKEND_FEATURES.filter(
      (f) => f.toggleDefault && !f.toggleDefault.category,
    ).map((f) => f.toggleDefault?.id);
    expect(uncategorized).toEqual([]);
  });

  it('funnels declares its cdp + cms coupling as recommendations (GRP-1)', () => {
    // funnels imports ../cdp and ../cms; both are now surfaced as soft recommends.
    expect(funnelsFeature.recommends ?? []).toEqual(
      expect.arrayContaining(['commerce', 'consent', 'cdp', 'cms']),
    );
  });
});
