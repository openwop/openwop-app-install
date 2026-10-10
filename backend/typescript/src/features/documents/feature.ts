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
import { buildDocumentsSurface, DOCUMENTS_SURFACE_POLICY } from './surface.js';
import { setLaunchStudioDocumentResolver } from '../../host/launchStudioSurface.js';
import { onCanvasDeleted } from '../../host/canvasLifecycle.js';
import { getDocumentByIdForTenant, clearPromotedCanvasRefs, listDocumentsOwnedBy, deleteDocument } from './documentsService.js';
import { registerSubjectDependent } from '../../host/subjectDependents.js';
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
    // ADR 0839 D2 — a document OWNED by a project goes with the project, through the
    // one full delete (versions, rendered bytes, share links, retention hold). Its read
    // gate asks the project, so once the project is gone the document is unreachable to
    // everyone. Matched inside the tenant on the exact owner Subject, deleted with the
    // row's own org.
    registerSubjectDependent('project', 'documents', {
      count: async (tenantId, subject) => (await listDocumentsOwnedBy(tenantId, subject)).length,
      purge: async (tenantId, subject) => {
        let n = 0;
        for (const d of await listDocumentsOwnedBy(tenantId, subject)) {
          if (await deleteDocument(tenantId, d.orgId, d.documentId)) n += 1;
        }
        return n;
      },
    });
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
  // ADR 0838 D3 — writers at the HTTP doors' write tier (`DOCWF2-3`).
  surface: { id: 'documents', build: buildDocumentsSurface, orgPolicy: DOCUMENTS_SURFACE_POLICY },
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
    { name: 'feature.documents.nodes', version: '1.3.3' }, // 1.3.3 = ADR 0838 DOCWF2-6: generate-from-template prose no longer claims a :fork converges; 1.3.1 = review F3: prose corrected — resume/replay converges, a :fork deliberately mints its own document (1.3.0 = WF-DOC-1/-4: deterministic generate ids; generate-from-template + render declared role:"side-effect"; 1.2.0 = ADR 0400 export formats)
    { name: 'vendor.openwop-app.documents.agents', version: '1.1.0' }, // 1.1.0 = ADR 0838 D5: document-author allowlists openwop:documents.revise
  ],
};
