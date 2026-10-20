import { describe, it, expect } from 'vitest';
import { FEATURES } from '../features.js';
import { visibleHubRoutes, tabIdOf } from '../hubProjection.js';

/**
 * ADR 0200 Phase 2 — Campaign Studio console. Asserts the manifest wiring that
 * consolidates the campaign chain: the console projects exactly the four campaign
 * tabs (and only its own), each gated by its own toggle, the standalone Marketing
 * nav collapses via `hiddenWhenFeature: 'campaigns'` while the routes stay
 * reachable, and the anchor id is `campaigns` (NOT `campaign-studio`, which is the
 * unrelated ADR 0153 in-chat canvas). Pure manifest derivations.
 *
 * Sabotage-witnessed (/grade-tests w30): reordering a tab, dropping a
 * `hiddenWhenFeature`, sharing a tab's toggle, renaming the anchor toggle to
 * `campaign-studio`, and dropping a route element each turn a case red.
 * (A former "does not collide" case was cut: its anchor half is case 2, and its
 * cross-console half could not fail — `inHub` puts a route in exactly one hub.)
 */
const byPath = (p: string) => FEATURES.find((r) => r.path === p);
const all = (): boolean => true;
const CAMPAIGN_PATHS = ['/campaign-ops', '/campaign-brief', '/campaigns', '/campaign-performance', '/campaign-intelligence'];

describe('ADR 0200 — Campaign Studio console', () => {
  // ADR 0926 D1 — Operations is the FIRST tab.
  it('projects exactly Operations → Briefs → Campaigns → Performance → Intelligence, in order', () => {
    expect(visibleHubRoutes(FEATURES, all, true, 'campaigns').map(tabIdOf)).toEqual([
      'campaign-ops', 'campaign-brief', 'campaigns', 'campaign-performance', 'campaign-intelligence',
    ]);
  });

  it('the /campaign-studio container is workspace-tier, gated on the `campaigns` toggle, not itself a tab', () => {
    const hub = byPath('/campaign-studio');
    expect(hub?.tier).toBe('workspace');
    expect(hub?.nav?.featureId).toBe('campaigns');
    expect(hub?.hubTab).toBeUndefined();
  });

  it('collapses the four standalone Marketing nav entries once `campaigns` is enabled', () => {
    for (const p of CAMPAIGN_PATHS) {
      expect(byPath(p)?.nav?.hiddenWhenFeature, p).toBe('campaigns');
    }
  });

  it('keeps the legacy routes reachable for deep links (no redirect)', () => {
    for (const p of CAMPAIGN_PATHS) {
      expect(byPath(p)?.element, p).toBeTruthy();
    }
  });

  it('each tab gates on its own sub-feature toggle (single-source gating)', () => {
    const only = (keep: string) => (id?: string) => id === keep || id === 'campaigns';
    expect(visibleHubRoutes(FEATURES, only('campaign-brief'), true, 'campaigns').map(tabIdOf)).toEqual(['campaign-brief']);
    expect(visibleHubRoutes(FEATURES, only('campaign-intel'), true, 'campaigns').map(tabIdOf)).toEqual(['campaign-intelligence']);
    expect(visibleHubRoutes(FEATURES, only('campaign-ops'), true, 'campaigns').map(tabIdOf)).toEqual(['campaign-ops']);
  });
});
