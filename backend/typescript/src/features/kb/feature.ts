/**
 * Knowledge Base / RAG (ADR 0011). Org-scoped collections + documents, an
 * ingest→chunk→embed→index pipeline, and semantic retrieval with citations.
 * COMPOSES existing host surfaces (the `db.vector` store + the deterministic
 * `embedText` embedder) rather than reinventing a vector store; sources are
 * pasted text or Media-Library asset tokens (ADR 0007). RBAC-gated
 * (workspace:read for search, workspace:write to ingest/manage). A `kb` toggle,
 * off by default (a new product surface).
 */

import type { BackendFeature } from '../types.js';
import { setKnowledgeBackend } from '../../host/knowledgeSurface.js';
import { registerKbRoutes } from './routes.js';
import { tenantRetrieve, TENANT_SCOPED_KB_ORGS } from './kbService.js';
import { buildKbSurface } from './surface.js';

export const kbFeature: BackendFeature = {
  id: 'kb',
  registerRoutes: (deps) => {
    registerKbRoutes(deps);
    // Back the `ctx.knowledge` host surface with the REAL tenant KB store (ADR
    // 0014 Phase 0 — the feature owns its infra, like notifications' emit
    // backend). Closes the ADR-0011 open question; falls back to the seeded demo
    // corpus for tenants with no KB / KB disabled.
    setKnowledgeBackend({ retrieve: tenantRetrieve });
  },
  // Face 2 (ADR 0014 Phase 1): the typed `ctx.features.kb` workflow surface.
  // ADR 0832 D2 — `_team`/`_kickbot` are tenant-level namespaces, not orgs: the
  // seam's org floor passes them by name on this surface and nowhere else.
  surface: { id: 'kb', build: buildKbSurface, orgPolicy: { tenantScopedOrgs: TENANT_SCOPED_KB_ORGS } },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
  // Face 3 (ADR 0014 Phase 2/3): the node pack over ctx.features.kb + the agent
  // pack tool-allowlisted to those nodes. Declared here, so featurePackRefs()
  // installs them at boot (Phase 0); the eager agent loader registers the agent.
  requiredPacks: [
    { name: 'feature.kb.nodes', version: '1.2.1' },
    { name: 'vendor.openwop-app.kb.agents', version: '1.0.2' },
  ],
};
