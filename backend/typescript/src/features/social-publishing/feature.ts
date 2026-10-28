/**
 * Social publishing (ADR 0953) — organic posts to Facebook Pages, Instagram,
 * LinkedIn, X, TikTok and YouTube, scheduled on the one scheduler and gated per
 * post by the campaign's autonomy policy (ADR 0942), with the approval bound to
 * the exact content.
 *
 * P0 here: the post store, its CAS state machine, routes and erasure. Nothing
 * publishes yet (the adapter is P1, the gated chain P2). Host extension, no RFC,
 * nothing advertised.
 *
 * @see docs/adr/0953-social-publishing-and-scheduling.md
 */
import type { BackendFeature } from '../types.js';
import { registerSocialPublishingRoutes, SOCIAL_PUBLISHING_TOGGLE } from './routes.js';
import { registerSocialPublishingErasure } from './erasure.js';

export const socialPublishingFeature: BackendFeature = {
  id: SOCIAL_PUBLISHING_TOGGLE,
  registerRoutes: (deps) => {
    registerSocialPublishingErasure();
    registerSocialPublishingRoutes(deps);
  },
  toggleDefault: {
    id: SOCIAL_PUBLISHING_TOGGLE,
    label: 'Social publishing',
    description:
      'Schedule and publish posts to your social accounts. Each post is checked against your content rules and approved for its exact text and media before it goes out, and each client keeps its own accounts and approvals.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'social-publishing',
  },
  // ADR 0953 matrix row 2 says `dependsOn: campaign-channels`. That lock lands with
  // the D6 handoff (P3), the first code that imports it; until then it would be a
  // phantom dependency (ADR 0439), so it is a recommendation.
  recommends: ['campaign-channels', 'campaign-orchestration', 'media'],
};
