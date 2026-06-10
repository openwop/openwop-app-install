/**
 * CSM — the second feature, added as a PURE addition (ADR 0001 §6 Phase 6).
 * Wiring it required ONLY appending to BACKEND_FEATURES (backend) and
 * FRONTEND_FEATURES (frontend) — zero edits to core route/nav code, which is
 * the whole point of the feature-package contract.
 *
 * A plain on/off feature (no variants, no packs) — showing the contract is not
 * coupled to multivariant. Tenant-bucketed, off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerCsmRoutes } from './routes.js';

export const csmFeature: BackendFeature = {
  id: 'csm',
  registerRoutes: (deps) => registerCsmRoutes(deps),
  toggleDefault: {
    id: 'csm',
    label: 'CSM',
    description: 'Customer-success accounts + health — sample product feature (ADR 0001 §6).',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'csm',
  },
};
