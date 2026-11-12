/**
 * Accessibility workflow surface (ADR 0363 P3 / ADR 0014) —
 * `ctx.features.accessibility`. Two ops, both composing existing owners:
 *
 *  - `checkContent(model)` — READ/pure: runs the backend content-a11y rules twin
 *    (`host/contentA11y.ts`) over an INLINE normalized model (NodeContext has no
 *    artifact-read seam — the P3 correction). Returns locale-free issues.
 *  - `generateAltText({ orgId, assetId })` — WRITE: forwards to the P1 media
 *    service `generateAltText` (the sibling-service pattern, ADR 0172 precedent),
 *    which already enforces tenant/org IDOR + provider-absence 422.
 *
 * Tenant comes from the run scope; `orgId` is node-supplied (CTI-1). Toggle
 * gating is automatic: `host/featureSurfaces` wraps every op with a per-run
 * `accessibility` toggle check because the feature declares a `toggleDefault`,
 * and with the org floor at the scope `orgPolicy` names (ADR 1100 D1).
 *
 * @see docs/adr/0363-authored-content-accessibility.md
 */

import { surfaceStr as str, type FeatureSurface, type FeatureSurfaceOrgPolicy } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { checkContentA11y, coerceContentA11yModel } from '../../host/contentA11y.js';
import { generateAltText } from '../media/mediaService.js';

/** ADR 1100 D1 — the seam's org floor asks `workspace:read` for any method this
 *  does not name. `generateAltText` is the route's `workspace:write`; `checkContent`
 *  reads nothing (it has no `orgId`, so no floor applies). */
export const ACCESSIBILITY_SURFACE_POLICY: FeatureSurfaceOrgPolicy = {
  methodScopes: { generateAltText: 'workspace:write' },
};

export function buildAccessibilitySurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // Pure content check — the same rules the editors run client-side (P2).
    checkContent: async (args) => ({ issues: checkContentA11y(coerceContentA11yModel(args)) }),

    // AI alt-text for a media asset — forwards to the media owner (composes the
    // ADR 0108 vision seam; media enforces IDOR + provider-absence). The org
    // floor checks `workspace:write` first (ADR 1100 D1,
    // ACCESSIBILITY_SURFACE_POLICY). The spend meters to the run's person (D7).
    generateAltText: async (args) => {
      const proposal = await generateAltText(tenantId, str(args.orgId), str(args.assetId), scope.actingUserId ? { actingSubject: scope.actingUserId } : {});
      return { assetId: proposal.assetId, altText: proposal.altText };
    },
  };
}
