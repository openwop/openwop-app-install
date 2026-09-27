/**
 * CDP (Customer Data Platform) — the umbrella feature package (ADR 0262/0263).
 *
 * CDP-A ships the identity-resolution surface: a read-only golden-record lookup
 * (`/cdp/identity/resolve`, `ctx.features.cdp.resolveIdentity`) that composes the
 * crm-owned identifier index. The package owns NO contact store (ADR 0262 ruling
 * #1 — crm owns the customer graph); it is a read/compose + console layer.
 *
 * Ships OFF, tenant-bucketed (a CDP is a shared B2B surface). Later sub-programs
 * (CDP-B…H) extend their own owners; the `cdp` toggle gates only this package's
 * surfaces (resolve + console).
 */

import type { BackendFeature } from '../types.js';
import { registerCdpRoutes } from './routes.js';
import { registerCdpAgentTools } from './agentTools.js';
import { buildCdpSurface } from './surface.js';
import { registerCdpErasure } from './erasure.js';

export const cdpFeature: BackendFeature = {
  id: 'cdp',
  requiredPacks: [{ name: 'feature.cdp.nodes', version: '1.1.0' }], // NP-HOLE-CDP-1; 1.1.0 = CLNP-3 masked output
  registerRoutes: (deps) => {
    registerCdpRoutes(deps);
    registerCdpAgentTools(); // XCH-HOLE-6 (round 3) — openwop:cdp.identity.resolve (ADR 0308 seam)
    // CONS-6 — the DSAR eraser for `cdp:collected-event`, the raw ingest store
    // that TAGS ITS OWN PII at ingest and had no eraser at all. Registered
    // unconditionally: `registerRoutes` runs regardless of the toggle, and an
    // erasure obligation is not a purchased feature. A MODULE-LEVEL named
    // reference (`erasure.ts` exports the function, this calls a registrar) —
    // an inline closure re-registers as a duplicate, because
    // `registerSubjectEraser` dedupes BY REFERENCE.
    registerCdpErasure();
  },
  surface: { id: 'cdp', build: buildCdpSurface },
  toggleDefault: {
    id: 'cdp',
    label: 'Customer Data Platform',
    description: 'Unified customer identity resolution — resolve a customer by any identifier (ADR 0263).',
    category: 'Customer Data Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'cdp',
  },
  // Consent powers purpose-propagation + consented collection across the CDP surface.
  recommends: ['consent'],
};
