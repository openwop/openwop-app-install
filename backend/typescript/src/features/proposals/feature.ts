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
import { registerProposalsAgentTools } from './agentTools.js';
import { registerProposalsRoutes } from './routes.js';
import { registerProposalsV2Routes } from './v2Routes.js';
import { registerProposalInstaller } from './proposalsService.js';
import { promptTemplateInstaller, rfc0249WireAvailable } from './installedPrompts.js';
import './erasure.js'; // PROPC-ERASURE-DSAR — side-effect: registers the proposals subject eraser + PII declaration at feature load

export const proposalsFeature: BackendFeature = {
  id: 'proposals',
  registerRoutes: (deps) => {
    // ADR 0972 D9 — the installer (and with it `agents.proposals`, `clientDrafts`
    // and `readback`) exists only once the pinned suite's schemas carry RFC 0249.
    if (rfc0249WireAvailable()) registerProposalInstaller('prompt-template', promptTemplateInstaller);
    registerProposalsRoutes(deps);
    registerProposalsV2Routes(deps); // RFC 0249 — 404 not_found until advertised
    registerProposalsAgentTools(); // XCH-HOLE-3 (Wave 4) — openwop:proposals.list (ADR 0308 seam)
  },
};
