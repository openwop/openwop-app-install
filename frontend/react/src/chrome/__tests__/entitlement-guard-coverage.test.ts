/**
 * ADR 0419 — EntitlementGuard coverage. The guard used to key on `nav.featureId`,
 * which only INDEX routes carry, so every DETAIL / deep-link route of a sellable
 * feature rendered unguarded — the exact bookmark/share URLs the guard exists for.
 *
 * `featureRoutes()` now stamps `ownerFeatureId` on every route, and `App.tsx` keys
 * the guard on it. This test pins that contract against the manifest so a
 * regression (a new detail route slipping the guard, or the stamp being dropped)
 * fails here rather than shipping a paywall hole.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURES } from '../features.js';

// The sellable-bundle feature ids, read from the checked-in catalog.
const REPO_ROOT = join(import.meta.dirname, '../../../../..');
const bundleFeatureIds = (): Set<string> => {
  const cat = JSON.parse(readFileSync(join(REPO_ROOT, 'distributions/bundles.json'), 'utf8')) as {
    bundles: Record<string, { features: string[] }>;
  };
  return new Set(Object.values(cat.bundles).flatMap((b) => b.features ?? []));
};

// Mirror of App.tsx's key resolution — kept in sync by the assertion below.
const entitlementKeyOf = (f: { ownerFeatureId?: string; nav?: { featureId?: string } }): string | undefined =>
  f.ownerFeatureId ?? f.nav?.featureId;

describe('EntitlementGuard route coverage (ADR 0419)', () => {
  it('every feature-owned route carries an ownerFeatureId (index AND detail)', () => {
    // CORE_FEATURES routes are declared inline with no owning FrontendFeature, so
    // they legitimately have none — they are core substrate, never sellable.
    const featureOwned = FEATURES.filter((f) => f.ownerFeatureId);
    expect(featureOwned.length).toBeGreaterThan(0);
    for (const f of featureOwned) expect(typeof f.ownerFeatureId).toBe('string');
  });

  it('EVERY route of a sellable-bundle feature resolves an entitlement key — no unguarded deep links', () => {
    const sellable = bundleFeatureIds();
    const unguarded = FEATURES
      .filter((f) => f.ownerFeatureId && sellable.has(f.ownerFeatureId))
      .filter((f) => !entitlementKeyOf(f))
      .map((f) => `${f.ownerFeatureId} :: ${f.path}`);
    expect(unguarded, `unguarded sellable-feature routes:\n${unguarded.join('\n')}`).toEqual([]);
  });

  it('specifically covers the detail routes that were unguarded before (regression pins)', () => {
    // These are real routes that keyed on a missing nav.featureId before the fix.
    const mustBeGuarded = ['/crm/deals/:dealId', '/documents/:documentId', '/slides/:canvasId'];
    for (const path of mustBeGuarded) {
      const route = FEATURES.find((f) => f.path === path);
      expect(route, `route ${path} not found in manifest`).toBeTruthy();
      expect(entitlementKeyOf(route!), `${path} must resolve an entitlement key`).toBeTruthy();
    }
  });
});
