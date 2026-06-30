/**
 * Documents & Templates feature (ADR 0053) — a versioned business-document store
 * (SOW/PRD/RFP/Epic-Brief/board-agenda) + a template library that BINDS the prompt
 * machinery to named kinds. Composes Media (bytes), KB (ingest), Sharing (links),
 * Subject-Memory + the Subject model (`ownerSubject`). Also extends the core app:
 * a `ctx.features.documents` workflow surface (ADR 0014) + `feature.documents.
 * {nodes,agents}` packs, all gated by the SAME `documents` toggle. Off by default.
 *
 * Artifact-types (RFC 0071/0075) are implemented host-side (ADR 0055): a bound
 * `artifactTypeId` is validated and the generate node emits a typed `artifact.created`.
 */

import type { BackendFeature } from '../types.js';
import { registerDocumentsRoutes } from './routes.js';
import { registerArtifactRoutes } from './artifactRoutes.js';
import { buildDocumentsSurface } from './surface.js';
import { setLaunchStudioDocumentResolver } from '../../host/launchStudioSurface.js';
import { getDocumentByIdForTenant } from './documentsService.js';

export const documentsFeature: BackendFeature = {
  id: 'documents',
  registerRoutes: (deps) => {
    registerDocumentsRoutes(deps);
    // ADR 0069 — the chat artifact workbench: a type-neutral read/diff projection
    // over the SAME documents data (no second store), gated on this toggle.
    registerArtifactRoutes(deps);
    // ADR 0056: let launch-studio resolve a sharedArtifactRef.documentId to the
    // owned document's projection (fill-a-seam; core never imports the feature).
    setLaunchStudioDocumentResolver(async (tenantId, documentId) => {
      const d = await getDocumentByIdForTenant(tenantId, documentId);
      return d ? { documentId: d.documentId, title: d.title, status: d.status } : null;
    });
  },
  surface: { id: 'documents', build: buildDocumentsSurface },
  toggleDefault: {
    id: 'documents',
    label: 'Documents & Templates',
    description: 'Versioned business-document store + template library (SOW/PRD/RFP/Epic-Brief/board-agenda) with agentic generate-from-template — product feature.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'documents',
  },
  requiredPacks: [
    { name: 'feature.documents.nodes', version: '1.1.0' },
    { name: 'feature.documents.agents', version: '1.0.0' },
  ],
};
