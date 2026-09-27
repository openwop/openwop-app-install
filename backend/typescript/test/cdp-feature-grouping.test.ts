import { describe, it, expect } from 'vitest';
import { cdpFeature } from '../src/features/cdp/feature.js';
import { consentFeature } from '../src/features/consent/feature.js';
import { destinationSyncFeature } from '../src/features/destination-sync/feature.js';
import { campaignJourneysFeature } from '../src/features/campaign-journeys/feature.js';

/**
 * Locks the CDP taxonomy: the CDP-cluster features share ONE toggle-console
 * category so the admin UI groups them together (they used to scatter across
 * 'Business Tools' / 'Marketing' / 'Workspace'), and the sub-features that
 * genuinely couple to the CDP core declare it as a dependency so the console
 * renders the relationship instead of leaving it invisible.
 */
describe('CDP feature grouping + dependency declaration', () => {
  const CDP_CATEGORY = 'Customer Data Platform';

  it('the CDP-cluster toggles all share the one CDP category', () => {
    for (const f of [cdpFeature, consentFeature, destinationSyncFeature, campaignJourneysFeature]) {
      expect(f.toggleDefault?.category).toBe(CDP_CATEGORY);
    }
  });

  it('destination-sync hard-depends on the CDP core (it imports cdp/purposeLabels)', () => {
    // dependsOn is the ADR 0194 disable-lock: CDP cannot be turned off while
    // destination-sync (which imports its purpose-label engine) is on.
    expect(destinationSyncFeature.dependsOn ?? []).toContain('cdp');
  });

  it('the cluster surfaces its soft dependencies as recommendations', () => {
    expect(cdpFeature.recommends ?? []).toContain('consent');
    expect(destinationSyncFeature.recommends ?? []).toEqual(
      expect.arrayContaining(['connections', 'consent']),
    );
    expect(campaignJourneysFeature.recommends ?? []).toEqual(
      expect.arrayContaining(['crm', 'email', 'consent']),
    );
  });
});
