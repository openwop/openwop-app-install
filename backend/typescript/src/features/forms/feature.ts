/**
 * Forms feature (ADR 0017) — the capture leg of the growth loop. An authed
 * org-scoped builder + a PUBLIC submit that best-effort creates a CRM contact
 * through `crmService` (not a direct store write). Also extends the core app: a
 * `ctx.features.forms` read surface (ADR 0014) + `feature.forms.{nodes,agents}`,
 * all gated by the SAME `forms` toggle. Off by default (a new product surface).
 */

import type { BackendFeature } from '../types.js';
import { registerFormsRoutes } from './routes.js';
import { buildFormsSurface } from './surface.js';

export const formsFeature: BackendFeature = {
  id: 'forms',
  registerRoutes: registerFormsRoutes,
  // Face 2 (ADR 0014): `ctx.features.forms` — a thin tenant-guarded read surface
  // over formsService that backs the feature.forms.nodes pack.
  surface: { id: 'forms', build: buildFormsSurface },
  toggleDefault: {
    id: 'forms',
    label: 'Forms',
    description: 'Public form builder + submissions → CRM contacts — product feature.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'forms',
  },
  requiredPacks: [
    { name: 'feature.forms.nodes', version: '1.0.0' },
    { name: 'feature.forms.agents', version: '1.0.0' },
  ],
};
