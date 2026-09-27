import { describe, it, expect } from 'vitest';
import { campaignIntelFeature } from '../routes.js';
import { tabIdOf } from '../../../chrome/hubProjection.js';

/**
 * Regression pin for grade-code DL-C-1: the `campaign.pacing` notification emits
 * `/campaigns?tab=campaign-intelligence&…` (backend pacing.ts). The hub derives a
 * tab id from the route path's last segment (`tabIdOf`), so if the campaign-intel
 * route path is ever renamed, this test fails — a signal to update the emitted
 * actionUrl, since `useUrlTab` would otherwise silently fall back to the first tab
 * and the `?campaign=` highlight would never fire.
 */
describe('campaign-intel notification deep-link', () => {
  it('projects as hub tab id "campaign-intelligence" (the campaign.pacing actionUrl depends on it)', () => {
    const hubRoute = campaignIntelFeature.routes.find((r) => r.hubTab);
    expect(hubRoute, 'campaign-intel must have a hubTab route').toBeDefined();
    expect(tabIdOf(hubRoute!)).toBe('campaign-intelligence');
  });
});
