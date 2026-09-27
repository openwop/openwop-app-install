/**
 * Consent feature (ADR 0020) — the GOVERN leg of the growth loop. A region-aware
 * consent store + the centralized enforcement helper Analytics (0018) + Email
 * (0019) call, plus a `ctx.features.consent` surface + `feature.consent.nodes`
 * (ADR 0014). No agent pack (honest — consent is a policy gate, not an AI surface).
 * Off by default (a new product surface; off ⇒ permissive, honest opt-in).
 */

import type { BackendFeature } from '../types.js';
import { registerConsentRoutes } from './routes.js';
import { registerConsentErasure } from './erasure.js';
import { buildConsentSurface } from './surface.js';

export const consentFeature: BackendFeature = {
  id: 'consent',
  registerRoutes: (deps) => {
    registerConsentRoutes(deps);
    // ADR 0657 D1 — the consent eraser on the host fan-out, toggle-independent (the
    // ADR 0655 D1 precedent): every ADR 0381-resolved key gets the record deleted AND
    // the tombstone written, from BOTH erase doors.
    registerConsentErasure();
  },
  // Face 2 (ADR 0014): `ctx.features.consent` — the same isAllowed/record helper,
  // exposed to workflow nodes (single enforcement path).
  surface: { id: 'consent', build: buildConsentSurface },
  toggleDefault: {
    id: 'consent',
    label: 'Consent',
    description: 'Region-aware consent + the enforcement gate for Analytics / Email — product feature.',
    category: 'Customer Data Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'consent',
  },
  // CONS-17 / WF-CONS-7 — bumped 1.0.0 -> 1.0.1 with the manifest text fix. The
  // pack sat at BIRTH 1.0.0 and `shouldShadow` is a strict `>`, so the moment a
  // registry copy is published at 1.0.0 every local fix becomes unshippable
  // without a version bump. Bumping WITH the first real correction keeps the
  // local mount ahead of any future registry copy rather than tied with it.
  //
  // WF-CONS-3 — 1.0.1 -> 1.1.0 with the fabricated-verdict fix. This pin is the
  // registry install TARGET when the pack is absent from disk, so it MUST move
  // in the same commit as `pack.json`: a bumped pack.json against a stale pin
  // fetches the OLD content under the new version.
  requiredPacks: [{ name: 'feature.consent.nodes', version: '1.2.0' }],
};
