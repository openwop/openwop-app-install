/**
 * Reviewable-learning proposals feature (RFC 0096) — ADR 0039 §Phase 1.
 *
 * Self-contained feature-package (ADR 0001): appended to BACKEND_FEATURES, zero
 * core edits beyond the registry line + the capability advertisement. Serves the
 * `/v1/host/openwop-app/proposals` seam unconditionally (always-on substrate, like
 * the assistant graph); the capability is advertised separately in `discovery.ts`
 * gated on `OPENWOP_PROPOSALS_ENABLED` so advertise/enforce parity is operator-
 * controlled per `capabilities.md`.
 */

import type { BackendFeature } from '../types.js';
import { registerProposalsRoutes } from './routes.js';

export const proposalsFeature: BackendFeature = {
  id: 'proposals',
  registerRoutes: (deps) => {
    registerProposalsRoutes(deps);
  },
};
