/**
 * Consent workflow surface (ADR 0014) — `ctx.features.consent`. Exposes the SAME
 * `isAllowed` / `record` helper that Analytics (0018) + Email (0019) consume
 * in-process (single enforcement path — no second consent rule) to workflow nodes.
 * Tenant comes from the run scope.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { isAllowed, recordConsent, type ConsentCategory } from './consentService.js';

export function buildConsentSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    isAllowed: async (args) => {
      const allowed = await isAllowed(tenantId, str(args.subjectKey), str(args.category) as ConsentCategory);
      return { allowed };
    },
    record: async (args) => {
      const rec = await recordConsent({ tenantId, subjectKey: str(args.subjectKey), categories: args.categories, source: 'workflow' });
      return { categories: rec.categories };
    },
  };
}
