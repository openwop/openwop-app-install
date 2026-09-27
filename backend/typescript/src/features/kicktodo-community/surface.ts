/**
 * `ctx.features.kicktodo-community` (ADR 0426 P5) — read-only: public
 * profile by handle, visible reviews + aggregate, the caller's counts-only
 * analytics. Writes stay on the governed REST surface (proof + approvals).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { revenueProjectionFor } from '../kicktodo-commerce/entitlementService.js';
import { publicProfileByHandle, visibleReviews, aggregateRating, creatorAnalytics } from './communityService.js';

export function buildKicktodoCommunitySurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    profile: async (args) => ({ profile: await publicProfileByHandle(tenant, surfaceStr(args.handle)) }),
    reviews: async (args) => {
      const challengeId = surfaceStr(args.challengeId);
      return {
        reviews: await visibleReviews(tenant, challengeId),
        aggregate: await aggregateRating(tenant, challengeId),
      };
    },
    analytics: async (args) => ({
      challenges: await creatorAnalytics(tenant, surfaceStr(args.creatorSubject), revenueProjectionFor),
    }),
  };
}
