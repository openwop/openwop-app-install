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
 */
const byPath = (p: string) => FEATURES.find((r) => r.path === p);
const all = (): boolean => true;
const CAMPAIGN_PATHS = ['/campaign-brief', '/campaigns', '/campaign-performance', '/campaign-intelligence'];

describe('ADR 0200 — Campaign Studio console', () => {
  it('projects exactly Briefs → Campaigns → Performance → Intelligence, in order', () => {
    expect(visibleHubRoutes(FEATURES, all, true, 'campaigns').map(tabIdOf)).toEqual([
      'campaign-brief', 'campaigns', 'campaign-performance', 'campaign-intelligence',
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
    expect(byPath('/campaign-intelligence')?.hubTab?.featureId).toBe('campaign-intel');
  });

  it('does not collide with the ADR 0153 campaign-studio canvas nor with other consoles', () => {
    // The canvas is a chat artifact (no FE nav route); the hub anchor is `campaigns`.
    expect(byPath('/campaign-studio')?.nav?.featureId).not.toBe('campaign-studio');
    const campaigns = visibleHubRoutes(FEATURES, all, true, 'campaigns').map(tabIdOf);
    const models = visibleHubRoutes(FEATURES, all, true, 'models').map(tabIdOf);
    const access = visibleHubRoutes(FEATURES, all, true, 'access').map(tabIdOf);
    expect(campaigns.filter((x) => models.includes(x) || access.includes(x))).toEqual([]);
  });
});
