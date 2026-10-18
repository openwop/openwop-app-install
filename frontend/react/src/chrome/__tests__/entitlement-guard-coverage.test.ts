/**
 * ADR 0419 — EntitlementGuard coverage. The guard used to key on `nav.featureId`,
 * which only INDEX routes carry, so every DETAIL / deep-link route of a sellable
 * feature rendered unguarded — the exact bookmark/share URLs the guard exists for.
 *
 * `featureRoutes()` now stamps `ownerFeatureId` on every route, and `App.tsx` keys
 * the guard on it. This test pins that contract against the manifest so a
 * regression (a new detail route slipping the guard, or the stamp being dropped)
 * fails here rather than shipping a paywall hole.
 *
 * w35 grade-tests: the sellable-route check used to filter on `ownerFeatureId`
 * and then test that same field, so it could never fail; it now starts from the
 * registry (which feature DECLARED each route) and checks the stamp the manifest
 * carries. App.tsx exports nothing testable, so its keying is a source witness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURES } from '../features.js';
import { FRONTEND_FEATURES } from '../../features/registry.js';

// The sellable-bundle feature ids, read from the checked-in catalog.
const REPO_ROOT = join(import.meta.dirname, '../../../../..');
const bundleFeatureIds = (): Set<string> => {
  const cat = JSON.parse(readFileSync(join(REPO_ROOT, 'distributions/bundles.json'), 'utf8')) as {
    bundles: Record<string, { features: string[] }>;
  };
  return new Set(Object.values(cat.bundles).flatMap((b) => b.features ?? []));
};

/** The manifest entry a declared feature route became (element identity survives the spread). */
const manifestEntryOf = (path: string, element: unknown) =>
  FEATURES.find((f) => f.path === path && f.element === element);

describe('EntitlementGuard route coverage (ADR 0419)', () => {
  it('every feature-owned route carries an ownerFeatureId (index AND detail)', () => {
    // CORE_FEATURES routes are declared inline with no owning FrontendFeature, so
    // they legitimately have none — they are core substrate, never sellable.
    const wrong: string[] = [];
    let checked = 0;
    for (const feature of FRONTEND_FEATURES) {
      for (const r of feature.routes) {
        checked += 1;
        const owner = manifestEntryOf(r.path, r.element)?.ownerFeatureId;
        if (owner !== feature.id) wrong.push(`${feature.id} :: ${r.path} -> ${String(owner)}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(wrong, `routes not stamped with their declaring feature:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('EVERY route of a sellable-bundle feature resolves an entitlement key — no unguarded deep links', () => {
    const sellable = bundleFeatureIds();
    const unguarded: string[] = [];
    let detailRoutes = 0;
    for (const feature of FRONTEND_FEATURES.filter((f) => sellable.has(f.id))) {
      for (const r of feature.routes) {
        if (!r.nav) detailRoutes += 1;
        const entry = manifestEntryOf(r.path, r.element);
        if (entry?.ownerFeatureId !== feature.id) unguarded.push(`${feature.id} :: ${r.path}`);
      }
    }
    // The class this guards is the DETAIL route (no nav entry); make sure some are in scope.
    expect(detailRoutes).toBeGreaterThan(3);
    expect(unguarded, `unguarded sellable-feature routes:\n${unguarded.join('\n')}`).toEqual([]);
  });

  it('App.tsx keys the guard on ownerFeatureId for both the workspace and admin route maps (source witness)', () => {
    const app = readFileSync(join(import.meta.dirname, '../../App.tsx'), 'utf8');
    expect(app).toContain('const entitlementKeyOf = (f: FeatureRoute): string | undefined => f.ownerFeatureId ?? f.nav?.featureId;');
    expect(app.split('element={entitlementKeyOf(f) ? <EntitlementGuard featureId={entitlementKeyOf(f)!}').length - 1).toBe(2);
  });

  it('specifically covers the detail routes that were unguarded before (regression pins)', () => {
    // These are real routes that keyed on a missing nav.featureId before the fix.
    const mustBeGuarded: Array<[string, string]> = [['/crm/deals/:dealId', 'crm'], ['/documents/:documentId', 'documents'], ['/slides/:canvasId', 'slides']];
    for (const [path, owner] of mustBeGuarded) {
      const route = FEATURES.find((f) => f.path === path);
      expect(route, `route ${path} not found in manifest`).toBeTruthy();
      expect(route?.nav, `${path} is a detail route (no nav entry)`).toBeUndefined();
      expect(route?.ownerFeatureId, `${path} must be keyed on its owning feature`).toBe(owner);
    }
  });
});
