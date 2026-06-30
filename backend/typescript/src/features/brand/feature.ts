/**
 * Brand (ADR 0155 voice facet + ADR 0170 identity facet). **Always-on / core** —
 * graduated from its OFF toggle by ADR 0170 (the ADR 0010/0024/0134 recipe: drop
 * `toggleDefault`, keep RBAC), because the app's OWN white-label identity is a
 * brand (`brand:host-app`) and the app cannot have its identity behind a toggle.
 * Owns the `Brand` entity: the voice facet (tone, formality, approved/banned
 * phrases, positioning, per-channel rules + compliance scorer) AND the identity
 * facet (logo/colors/typography/theme), plus node/agent packs + a
 * `ctx.features.brand` surface.
 *
 * No parallel architecture: brand governance maps onto `accessControl` (RFC 0049),
 * not a second ACL; the Brand Steward agent drives it through the ONE chat (ADR
 * 0058), never a bespoke panel. Graduation removes ONLY the feature-toggle gate —
 * every route keeps its `workspace:*` RBAC + governance authority (see routes.ts).
 *
 * RFC gate: host-extension under /v1/host/openwop-app/brand/*, composing accepted
 * feature surfaces. NO new RFC.
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 * @see docs/adr/0170-brand-identity-app-and-marketing-consolidation.md
 */

import type { BackendFeature } from '../types.js';
import { registerBrandRoutes } from './routes.js';
import { buildBrandSurface } from './surface.js';

export const brandFeature: BackendFeature = {
  id: 'brand',
  registerRoutes: (deps) => registerBrandRoutes(deps),
  surface: { id: 'brand', build: buildBrandSurface },
  requiredPacks: [
    { name: 'feature.brand.nodes', version: '1.1.0' },
    { name: 'feature.brand.agents', version: '1.0.0' },
  ],
  // ADR 0170: NO `toggleDefault` — brand is always-on/core (like cms/connections
  // per ADR 0027 / ADR 0024 §Correction). RBAC stays enforced in routes.ts.
};
