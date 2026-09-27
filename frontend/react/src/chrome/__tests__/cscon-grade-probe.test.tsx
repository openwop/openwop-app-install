/**
 * GRADING PROBE — "Campaign Studio console" (FEATURES.md ordinal 224, ADR 0200).
 * Evidence only. GREEN + CI-safe. Exercises the shared hub projector
 * `chrome/hubProjection.ts`.
 *
 * MID-GRADE CORRECTION: my first pass (vs the pre-#3493 base) filed `CSCC-1` — the
 * shared projector was tier-BLIND (the AHC-1/MHC-1/CDC-1 family), and this console
 * had no admin-gate second line. While that pass was parked on the load-gate,
 * #3493 ("tier-aware hub projection — one shared fix closes AHC-1/MHC-1/CDC-1")
 * merged, adding an `isAdmin` param + a `r.tier !== 'admin' || isAdmin` filter and
 * wiring `isAdmin = isAdminCaller(useEffectiveAccess())` into
 * `CampaignStudioHubPage.tsx:33-35`. So CSCC-1 is CLOSED on origin/main. This probe
 * is re-aimed to WITNESS the fix rather than report a stale gap.
 *
 * CSCP-1 (the campaigns tabs are all workspace-tier): projected identically for an
 *     admin and a non-admin caller — workspace surfaces are visible to everyone.
 * CSCP-2 (the fix — tier-AWARE): a synthetic admin-tier tab annotated into hub
 *     'campaigns' is DROPPED for a non-admin caller and SHOWN for an admin — the
 *     projection is no longer tier-blind, so the future mis-scope CSCC-1 warned of
 *     can no longer fire.
 * CSCP-3 (control): the hub discriminator + visibility filters still apply.
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
    expect(asNonAdmin.length).toBeGreaterThan(0);
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
