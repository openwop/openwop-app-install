/**
 * Consent feature (ADR 0020) — the GOVERN leg of the growth loop. A region-aware
 * consent store + the centralized enforcement helper Analytics (0018) + Email
 * (0019) call, plus a `ctx.features.consent` surface + `feature.consent.nodes`
 * (ADR 0014). No agent pack (honest — consent is a policy gate, not an AI surface).
 * Off by default (a new product surface; off ⇒ permissive, honest opt-in).
 */

import type { BackendFeature } from '../types.js';
import { registerConsentRoutes } from './routes.js';
import { buildConsentSurface } from './surface.js';

export const consentFeature: BackendFeature = {
  id: 'consent',
  registerRoutes: registerConsentRoutes,
  // Face 2 (ADR 0014): `ctx.features.consent` — the same isAllowed/record helper,
  // exposed to workflow nodes (single enforcement path).
  surface: { id: 'consent', build: buildConsentSurface },
  toggleDefault: {
    id: 'consent',
    label: 'Consent',
    description: 'Region-aware consent + the enforcement gate for Analytics / Email — product feature.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'consent',
  },
  requiredPacks: [{ name: 'feature.consent.nodes', version: '1.0.0' }],
};
