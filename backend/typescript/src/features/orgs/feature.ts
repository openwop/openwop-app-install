/**
 * Org invitations (ADR 0004, reconciled). Organizations / members / roles are
 * owned by the `accessControl` surface (RFC 0049); this feature adds ONLY the
 * email-token invitation flow that delegates to it (see invitationsService /
 * the amended ADR). An `orgs` toggle, off by default.
 *
 * ADR 0622 — the invitation lifecycle is now a SEAM, not a dead end: four
 * ids-only host events (`emit.ts`, D1) a tenant can bind a chain to, and the
 * `ctx.features.orgs` workflow surface (`surface.ts`, D2) behind the
 * `feature.orgs.nodes` pack so a chain can invite someone into THIS workspace.
 * Toggle gating of the surface is automatic (`host/featureSurfaces.ts` wraps
 * every method with the `orgs` toggle resolved against the RUN's tenant); the
 * surface's OWN gate is `assertOrgScope(host:members:manage)` on the run's
 * acting user (fail-closed without one).
 */

import type { BackendFeature } from '../types.js';
import { registerOrgsRoutes } from './routes.js';
import { buildOrgsSurface } from './surface.js';

export const orgsFeature: BackendFeature = {
  id: 'orgs',
  registerRoutes: (deps) => registerOrgsRoutes(deps),
  toggleDefault: {
    id: 'orgs',
    label: 'Org invitations',
    description: 'Email-token invitations to join an organization as a member. Orgs/members/roles are owned by the accessControl surface; this delegates to it.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'orgs',
  },
  surface: { id: 'orgs', build: buildOrgsSurface },
  requiredPacks: [{ name: 'feature.orgs.nodes', version: '1.0.0' }],
};
