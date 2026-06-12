/**
 * Email Marketing feature (ADR 0019) — the ENGAGE leg. Templates + campaigns over
 * CRM contacts (audience resolved live), consent-gated marketing sends through a
 * stub provider, plus a `ctx.features.email` read surface (ADR 0014) +
 * `feature.email.{nodes,agents}`, all behind the same `email` toggle. Authed-only
 * (no public surface). Off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerEmailRoutes } from './routes.js';
import { buildEmailSurface } from './surface.js';

export const emailFeature: BackendFeature = {
  id: 'email',
  registerRoutes: registerEmailRoutes,
  // Face 2 (ADR 0014): `ctx.features.email` — a thin read surface (templates) that
  // backs the feature.email.nodes pack + the copywriter agent.
  surface: { id: 'email', build: buildEmailSurface },
  toggleDefault: {
    id: 'email',
    label: 'Email Marketing',
    description: 'Templated campaigns over CRM contacts, consent-gated marketing sends — product feature (ADR 0019).',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'email',
  },
  requiredPacks: [
    { name: 'feature.email.nodes', version: '1.0.0' },
    { name: 'feature.email.agents', version: '1.0.0' },
  ],
};
