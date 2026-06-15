/**
 * Portability feature (RFC 0098) — ADR 0039 §Phase 3.
 *
 * Self-contained feature-package (ADR 0001): appended to BACKEND_FEATURES. Serves
 * the `/v1/host/openwop-app/{export,import}` seam unconditionally; the top-level
 * `portability` capability is advertised separately in `discovery.ts` gated on
 * `OPENWOP_PORTABILITY_ENABLED`. openwop-app is the `portability.import`
 * non-vacuous graduation witness for RFC 0098 (Active→Accepted).
 */

import type { BackendFeature } from '../types.js';
import { registerPortabilityRoutes } from './routes.js';

export const portabilityFeature: BackendFeature = {
  id: 'portability',
  registerRoutes: (deps) => {
    registerPortabilityRoutes(deps);
  },
};
