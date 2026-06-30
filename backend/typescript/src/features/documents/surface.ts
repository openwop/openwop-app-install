/**
 * Documents workflow surface (ADR 0014 / ADR 0053) — `ctx.features.documents`, the
 * typed surface a workflow node calls. Tenant comes from the run scope; org-scoped
 * reads/writes are tenant+org-guarded by the service (CTI-1). This is the agentic
 * half: a `documents.generateFromTemplate` node calls `assemble` → `ctx.callAI` →
 * `createDocument`/`addVersion` (idempotency-keyed so a replay/fork doesn't dup).
 * Generation itself stays in the node (provider is run-scoped); the surface only
 * assembles + persists.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import {
  listTemplates, getTemplate, assemble,
  listDocuments, getDocument, createDocument, addVersion, renderDocument,
  type Provenance, type RenderFormat,
} from './documentsService.js';
import { validateArtifact } from '../../host/artifactTypes.js';

const DOC_INTERNAL = new Set(['tenantId', 'createdBy', 'updatedBy']);
function project(o: object, drop: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!drop.has(k)) out[k] = v;
  return out;
}

export function buildDocumentsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const runId = (scope as { runId?: string }).runId;
  const runProvenance = (extra?: Partial<Provenance>): Provenance => ({
    producedBy: { kind: 'run', id: runId ?? 'run' },
    ...(runId ? { runId } : {}),
    ...extra,
  });

  return {
    listTemplates: async (args) => ({ templates: await listTemplates(tenantId, str(args.orgId), optStr(args.kind)) }),
    getTemplate: async (args) => {
      const tmpl = await getTemplate(tenantId, str(args.orgId), str(args.templateId));
      return { template: tmpl ?? null };
    },
    // Validate + render a template into an augmentedPrompt (no LLM call — the node
    // feeds this to ctx.callAI, then writes the result back via addVersion).
    assemble: async (args) => ({ ...(await assemble(tenantId, str(args.orgId), str(args.templateId), (args.params as Record<string, unknown>) ?? {})) }),

    listDocuments: async (args) => {
      const documents = await listDocuments(tenantId, str(args.orgId), optStr(args.kind) ? { kind: optStr(args.kind)! } : undefined);
      return { documents: documents.map((d) => project(d, DOC_INTERNAL)) };
    },
    getDocument: async (args) => {
      const doc = await getDocument(tenantId, str(args.orgId), str(args.documentId));
      return { document: doc ? project(doc, DOC_INTERNAL) : null };
    },
    createDocument: async (args) => {
      const doc = await createDocument({
        tenantId, orgId: str(args.orgId), title: args.title, kind: args.kind, format: args.format,
        ownerSubject: args.ownerSubject,
        ...(optStr(args.templateId) ? { templateId: optStr(args.templateId)! } : {}),
        ...(optStr(args.documentId) ? { documentId: optStr(args.documentId)! } : {}),
        provenance: runProvenance(optStr(args.templateId) ? { templateId: optStr(args.templateId) } : {}),
        createdBy: runId ?? 'run',
      });
      return { document: project(doc, DOC_INTERNAL) };
    },
    // Create a markdown handoff document in ONE owned call (ADR 0166): guard the
    // content, then the deterministic-id createDocument + idempotency-keyed addVersion
    // two-step — so a publish node never leaves an empty container and a replay/fork
    // reuses the same doc+version. Mirrors cms.createDraftPage / email.createDraftCampaign.
    createDraftDocument: async (args) => {
      const content = str(args.content);
      if (content.trim().length === 0) {
        return { error: { code: 'empty_content', message: 'Refusing to create a document with empty content.' } };
      }
      // Guard size BEFORE creating the container — addVersion would otherwise throw on
      // an over-cap version and leave an orphan contentless document (mirror MAX.contentBytes).
      if (content.length > 1_000_000) {
        return { error: { code: 'content_too_large', message: 'Document content exceeds the 1 MB cap.' } };
      }
      const base = optStr(args.idemBase) ?? `${runId ?? 'run'}`;
      const documentId = `doc:${base}`;
      const doc = await createDocument({
        tenantId, orgId: str(args.orgId), documentId,
        title: str(args.title) || 'Campaign document',
        kind: str(args.kind) || 'doc', format: 'markdown',
        provenance: runProvenance(), createdBy: runId ?? 'run',
      });
      const version = await addVersion(tenantId, str(args.orgId), doc.documentId, {
        content,
        producedBy: { kind: 'run', id: runId ?? 'run' },
        idempotencyKey: base,
      });
      return { document: project(doc, DOC_INTERNAL), version: { versionId: version.versionId, version: version.version } };
    },
    // Idempotency-keyed write — a replayed/forked run reuses the same version.
    addVersion: async (args) => {
      const version = await addVersion(tenantId, str(args.orgId), str(args.documentId), {
        content: args.content,
        ...(optStr(args.renderedMediaToken) ? { renderedMediaToken: optStr(args.renderedMediaToken)! } : {}),
        producedBy: { kind: 'run', id: runId ?? 'run' },
        ...(optStr(args.idempotencyKey) ? { idempotencyKey: optStr(args.idempotencyKey)! } : {}),
      });
      return { version };
    },
    // Render the current version to PDF → Media token (deterministic; ADR 0057).
    render: async (args) => ({ ...(await renderDocument(tenantId, str(args.orgId), str(args.documentId), runId ?? 'run', (optStr(args.format) as RenderFormat | undefined) ?? 'pdf')) }),
    // Validate an artifact payload against a registered host artifact type (ADR 0055),
    // so the generate node can emit a correctly-marked artifact.created.
    validateArtifact: async (args) => ({ ...validateArtifact(str(args.artifactTypeId), args.payload) }),
  };
}
