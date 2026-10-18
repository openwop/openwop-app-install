/**
 * `ctx.features.kicktodo-community` (ADR 0426 P5) — read-only: public
 * profile by handle, visible reviews + aggregate, the caller's counts-only
 * analytics. Writes stay on the governed REST surface (proof + approvals).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { revenueProjectionFor } from '../kicktodo-commerce/entitlementService.js';
import { publicProfileByHandle, visibleReviews, aggregateRating, creatorAnalytics } from './communityService.js';
import { bindKicktodoSurface, type KicktodoSurfaceSpecs } from '../kicktodo-core/surfaceBinding.js';

/** ADR 0901 (DEC-1) — the run-principal spec per method (`surfaceBinding.ts`).
 *  `analytics` is the CALLER's own revenue projection (the route passes
 *  `subjectOf(req)`); profile and reviews are public reads. */
export const KICKTODO_COMMUNITY_SURFACE_SPECS = {
  profile: { authority: 'none' },
  reviews: { authority: 'none' },
  analytics: { subjectArg: 'creatorSubject', authority: 'none', personOnly: true },
} as const satisfies KicktodoSurfaceSpecs;

export function buildKicktodoCommunitySurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return bindKicktodoSurface('kicktodo-community', scope, {
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
  }, KICKTODO_COMMUNITY_SURFACE_SPECS);
}
