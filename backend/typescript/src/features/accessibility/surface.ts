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
 * `accessibility` toggle check because the feature declares a `toggleDefault`.
 *
 * @see docs/adr/0363-authored-content-accessibility.md
 */

import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { checkContentA11y, coerceContentA11yModel } from '../../host/contentA11y.js';
import { generateAltText } from '../media/mediaService.js';

export function buildAccessibilitySurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // Pure content check — the same rules the editors run client-side (P2).
    checkContent: async (args) => ({ issues: checkContentA11y(coerceContentA11yModel(args)) }),

    // AI alt-text for a media asset — forwards to the media owner (composes the
    // ADR 0108 vision seam; media enforces IDOR + provider-absence).
    generateAltText: async (args) => {
      const proposal = await generateAltText(tenantId, str(args.orgId), str(args.assetId));
      return { assetId: proposal.assetId, altText: proposal.altText };
    },
  };
}
