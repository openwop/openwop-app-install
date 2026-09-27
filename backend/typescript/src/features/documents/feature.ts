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
import { onCanvasDeleted } from '../../host/canvasLifecycle.js';
import { getDocumentByIdForTenant, clearPromotedCanvasRefs } from './documentsService.js';
import { registerDocumentsAgentTools } from './agentTools.js';
import { registerDocumentsErasure } from './erasure.js';

export const documentsFeature: BackendFeature = {
  id: 'documents',
  registerRoutes: (deps) => {
    registerDocumentsRoutes(deps);
    // ADR 0308 P1 — the `openwop:documents.draft` agent deliverable tool
    // (feature-registered builtin; allowlist default-deny + firewall unchanged;
    // the tool re-checks the `documents` toggle per tenant at run time).
    registerDocumentsAgentTools();
    // DOC2-B1 — subject erasure + PII classification. Registered HERE (not as a
    // module side effect) so it is greppable from the feature definition and a
    // test can assert it was wired, not merely that the handler exists.
    registerDocumentsErasure();
    // ADR 0069 — the chat artifact workbench: a type-neutral read/diff projection
    // over the SAME documents data (no second store), gated on this toggle.
    registerArtifactRoutes(deps);
    // ADR 0056: let launch-studio resolve a sharedArtifactRef.documentId to the
    // owned document's projection (fill-a-seam; core never imports the feature).
    setLaunchStudioDocumentResolver(async (tenantId, documentId) => {
      const d = await getDocumentByIdForTenant(tenantId, documentId);
      return d ? { documentId: d.documentId, title: d.title, status: d.status } : null;
    });
    // ADR 0350 Phase 3 follow-up (DOCS-1) — a deleted rich canvas.document must
    // not leave `promotedCanvasId` dangling on its source markdown doc. The
    // keyed canvas-lifecycle seam (comments/collab precedent): fired after the
    // canvas row is gone, best-effort, gated on the type.
    onCanvasDeleted('documents-promote', async ({ tenantId, canvasId, canvasTypeId }) => {
      if (canvasTypeId !== 'canvas.document') return;
      await clearPromotedCanvasRefs(tenantId, canvasId);
    });
  },
  surface: { id: 'documents', build: buildDocumentsSurface },
  toggleDefault: {
    id: 'documents',
    label: 'Documents & Templates',
    description: 'Versioned business-document store + template library (SOW/PRD/RFP/Epic-Brief/board-agenda) with agentic generate-from-template — product feature.',
    category: 'Studio',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'documents',
  },
  requiredPacks: [
    { name: 'feature.documents.nodes', version: '1.3.1' }, // 1.3.1 = review F3: prose corrected — resume/replay converges, a :fork deliberately mints its own document (1.3.0 = WF-DOC-1/-4: deterministic generate ids; generate-from-template + render declared role:"side-effect"; 1.2.0 = ADR 0400 export formats)
    { name: 'feature.documents.agents', version: '1.0.2' },
  ],
};
