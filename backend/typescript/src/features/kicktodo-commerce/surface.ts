/**
 * `ctx.features.kicktodo-commerce` (ADR 0420 P5) — READ-ONLY checks for
 * workflows (the factory's pricing step, the daily loop's paid-state chip),
 * plus the ADR 0451 P4 referral-code ENSURE (idempotent — resolve-or-mint).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { getEntitlement, isChallengePaid, productForChallenge } from './entitlementService.js';
import { ensureAffiliateForSubject } from './subjectAffiliateBridge.js';
import { seatAvailability as readSeatAvailability } from './seatService.js';

export function buildKicktodoCommerceSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    /** ADR 0431 P5 — seat availability for a cohort product (counts only). */
    seatAvailability: async (args) => ({
      availability: await readSeatAvailability(tenant, surfaceStr(args.buyerSubject), surfaceStr(args.productId)),
    }),
    isPaid: async (args) => ({
      paid: await isChallengePaid(tenant, surfaceStr(args.challengeId), typeof args.challengeVersion === 'number' ? args.challengeVersion : 1),
    }),
    entitlement: async (args) => ({
      entitlement: await getEntitlement(
        tenant,
        surfaceStr(args.buyerSubject),
        surfaceStr(args.challengeId),
        typeof args.challengeVersion === 'number' ? args.challengeVersion : 1,
      ),
    }),
    /** ADR 0451 P4 — the referrer's affiliate code for a PAID challenge, so a
     *  workflow can build the `?ref=` invite link. Idempotent (resolve-or-mint);
     *  `code: null` for a free challenge (nothing to refer). */
    referralCode: async (args) => {
      const version = typeof args.challengeVersion === 'number' ? args.challengeVersion : 1;
      const priceInfo = await productForChallenge(tenant, surfaceStr(args.challengeId), version);
      if (!priceInfo) return { code: null };
      const link = await ensureAffiliateForSubject(tenant, priceInfo.orgId, surfaceStr(args.ownerSubject));
      return { code: link.code };
    },
  };
}
