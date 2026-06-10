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
import { tenantRetrieve } from './kbService.js';
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
  surface: { id: 'kb', build: buildKbSurface },
  toggleDefault: {
    id: 'kb',
    label: 'Knowledge Base',
    description: 'Org-scoped document collections + semantic retrieval with citations (RAG). Sources are pasted text or Media-Library asset tokens (ADR 0007); ingest chunks + embeds into the host vector store (in-memory ↔ pgvector) via the deterministic local embedder. Grounded answers are produced by feeding the augmented context to a workflow agent (the provider is run-scoped). RBAC-gated via accessControl.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kb',
  },
  // Face 3 (ADR 0014 Phase 2/3): the node pack over ctx.features.kb + the agent
  // pack tool-allowlisted to those nodes. Declared here, so featurePackRefs()
  // installs them at boot (Phase 0); the eager agent loader registers the agent.
  requiredPacks: [
    { name: 'feature.kb.nodes', version: '1.0.0' },
    { name: 'feature.kb.agents', version: '1.0.0' },
  ],
};
