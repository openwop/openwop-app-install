/**
 * ADR 0194 (feature dependency graph + lifecycle) — locks the Sales + Commerce
 * sections carved out of the 'Business Tools' / 'Workspace' catch-alls for the
 * sales/merchandising features, plus the funnels Marketing placement.
 * Companion to the cdp- and crm-studio-grouping tests.
 *
 * What reads these fields: `toggleDefault.category` is the group heading the
 * admin toggle panel (`frontend/react/src/featureToggles/FeatureTogglePanel.tsx`)
 * files each feature under; `dependsOn` feeds ADR 0194's disable-lock (a
 * feature cannot be turned off while a dependant is on) and
 * `docs/FEATURE-DEPENDENCIES.md`; `recommends` is the soft, non-locking edge.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): territories' `dependsOn:
 * ['crm']` emptied (`8fw2g3-scg-deps`) and sales-maps moved back to 'Business
 * Tools' (`-scg-cat`).
 */
import { describe, it, expect } from 'vitest';
import { dealersFeature } from '../src/features/dealers/feature.js';
import { territoriesFeature } from '../src/features/territories/feature.js';
import { salesCommissionsFeature } from '../src/features/sales-commissions/feature.js';
import { salesMapsFeature } from '../src/features/sales-maps/feature.js';
import { commerceFeature } from '../src/features/commerce/feature.js';
import { discoveryFeature } from '../src/features/discovery/feature.js';
import { promotionsFeature } from '../src/features/promotions/feature.js';
import { recommendationsFeature } from '../src/features/recommendations/feature.js';
import { funnelsFeature } from '../src/features/funnels/feature.js';

describe('Sales + Commerce feature grouping + dependency declaration', () => {
  it('the field-sales cluster shares the one Sales category', () => {
    for (const f of [dealersFeature, territoriesFeature, salesCommissionsFeature, salesMapsFeature]) {
      expect(f.toggleDefault?.category).toBe('Sales');
    }
  });

  it('the commerce/merchandising cluster shares the one Commerce category', () => {
    for (const f of [commerceFeature, discoveryFeature, promotionsFeature, recommendationsFeature]) {
      expect(f.toggleDefault?.category).toBe('Commerce');
    }
  });

  it('funnels stays in Marketing', () => {
    expect(funnelsFeature.toggleDefault?.category).toBe('Marketing');
  });

  it('dependencies are declared where the coupling is real', () => {
    // hard: territories layers over CRM; commerce/discovery/promotions/recommendations over commerce.
    expect(territoriesFeature.dependsOn ?? []).toContain('crm');
    for (const f of [discoveryFeature, promotionsFeature, recommendationsFeature]) {
      expect(f.dependsOn ?? []).toContain('commerce');
    }
    // soft: funnels' consent-gated events; sales-maps colours territories.
    expect(funnelsFeature.recommends ?? []).toContain('consent');
    expect(salesMapsFeature.recommends ?? []).toContain('territories');
  });
});
