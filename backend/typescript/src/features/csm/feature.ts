/**
 * CSM — the second feature, added as a PURE addition (ADR 0001 §6 Phase 6).
 * Wiring it required ONLY appending to BACKEND_FEATURES (backend) and
 * FRONTEND_FEATURES (frontend) — zero edits to core route/nav code, which is
 * the whole point of the feature-package contract.
 *
 * Tenant-bucketed, off by default. Originally a plain on/off feature with no
 * packs; extended 2026-06-10 (ADR 0016 Correction / `/feature` audit) with the
 * core-app extension surface — a `ctx.features.csm` workflow surface + node/agent
 * packs — all behind the SAME `csm` toggle.
 */

import type { BackendFeature } from '../types.js';
import { registerCsmRoutes } from './routes.js';
import { buildCsmSurface } from './surface.js';

export const csmFeature: BackendFeature = {
  id: 'csm',
  registerRoutes: (deps) => registerCsmRoutes(deps),
  // Face 2 (ADR 0014): `ctx.features.csm` — a thin, tenant-guarded read/health
  // adapter over accountsService that backs the feature.csm.nodes pack.
  surface: { id: 'csm', build: buildCsmSurface },
  toggleDefault: {
    id: 'csm',
    label: 'CSM',
    description: 'Customer-success accounts + health — sample product feature.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'csm',
  },
  requiredPacks: [
    { name: 'feature.csm.nodes', version: '1.0.0' },
    { name: 'feature.csm.agents', version: '1.0.0' },
  ],
};
