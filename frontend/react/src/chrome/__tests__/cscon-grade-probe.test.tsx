/**
 * ADR 0200 Campaign Studio console (FEATURES.md ordinal 224) — the hub projector
 * `chrome/hubProjection.ts` is TIER-AWARE for the campaigns console (CSCC-1, closed by
 * #3493). Durable claim: (CSCP-1) every campaigns tab is workspace-tier, so admin and
 * non-admin callers see the same five tabs (Operations added by ADR 0926); (CSCP-2) an admin-tier tab annotated into the
 * campaigns hub is DROPPED for a non-admin and SHOWN for an admin; (CSCP-3) the hub
 * discriminator and the toggle gate still apply.
 *
 * Origin: the ordinal-224 feature-grade probe (docs/steward/CODEBASE-ASSESSMENT.md); its
 * first pass filed CSCC-1 against the pre-#3493 base and was re-aimed to witness the fix.
 *
 * Sabotage that turns it red: drop the `r.tier !== 'admin' || isAdmin` filter (CSCP-2);
 * make a campaigns route admin-tier (CSCP-1); make `inHub` match every hub (CSCP-3).
 *
 * DEDUPE CANDIDATE (needs a human ask — protected authz): CSCP-2/3 overlap
 * `features/access-hub/__tests__/hubProjection.test.ts` ("drops the admin-tier tab for a
 * non-admin caller", "filters by the hub discriminator"); CSCP-1 is unique.
 */
import { describe, it, expect } from 'vitest';
import { FEATURES } from '../features.js';
import { visibleHubRoutes, tabIdOf } from '../hubProjection.js';
import type { FeatureRoute } from '../featureTypes.js';

const allVisible = (): boolean => true;

const ADMIN_TAB: FeatureRoute = {
  path: '/synthetic-admin-surface',
  archetype: 'standard-index',
  element: <div />,
  tier: 'admin',
  hubTab: { hub: 'campaigns', featureId: 'synthetic-admin' },
};

describe('ADR 0200 campaign console — tier-AWARE projection (CSCC-1 closed by #3493, by execution)', () => {
  it('CSCP-1: the campaigns tabs are all workspace-tier → projected for admin AND non-admin alike', () => {
    const asNonAdmin = visibleHubRoutes(FEATURES, allVisible, false, 'campaigns');
    const asAdmin = visibleHubRoutes(FEATURES, allVisible, true, 'campaigns');
    expect(asNonAdmin).toHaveLength(5); // Operations (ADR 0926), Briefs, Campaigns, Performance, Intelligence (ADR 0200)
    expect(asNonAdmin.map(tabIdOf)).toEqual(asAdmin.map(tabIdOf)); // workspace tabs visible to everyone
    expect(asNonAdmin.map((t) => t.tier)).toEqual(asNonAdmin.map(() => 'workspace'));
  });

  it('CSCP-2: the projector is now TIER-AWARE — an admin-tier tab is DROPPED for a non-admin, SHOWN for an admin', () => {
    expect(visibleHubRoutes([ADMIN_TAB], allVisible, false, 'campaigns').map(tabIdOf)).not.toContain('synthetic-admin-surface');
    expect(visibleHubRoutes([ADMIN_TAB], allVisible, true, 'campaigns').map(tabIdOf)).toContain('synthetic-admin-surface');
  });

  it('CSCP-3 (control): the hub discriminator + visibility filters still apply', () => {
    const otherHub: FeatureRoute = { ...ADMIN_TAB, tier: 'workspace', hubTab: { hub: 'models', featureId: 'x' } };
    expect(visibleHubRoutes([otherHub], allVisible, true, 'campaigns')).toHaveLength(0); // wrong hub
    const wsTab: FeatureRoute = { ...ADMIN_TAB, tier: 'workspace' };
    expect(visibleHubRoutes([wsTab], () => false, true, 'campaigns')).toHaveLength(0); // gated invisible
  });
});
