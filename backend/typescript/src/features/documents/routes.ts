/**
 * Documents & Templates routes (host-extension, ADR 0053).
 *   Authed (org-scoped, RBAC):  /v1/host/openwop-app/documents/orgs/:orgId/*
 * All routes are toggle-gated (`documents`) + `authorizeOrgScope`-gated (read =
 * workspace:read, write = workspace:write, status-approve = host:members:manage via
 * the write path here in v1). A project-owned document's org is the path org; the
 * Subject seam validates the owner resolves to it (documentsService).
 *
 * Generation is run-scoped: `assemble` returns an augmentedPrompt + outputSchema
 * (no LLM call); the agent/node writes versions back via this surface / ctx.documents.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import type { Subject, SubjectKind } from '../../host/subject.js';
import { ingestDocument } from '../kb/kbService.js';
import {
  listDocuments, getDocument, createDocument, updateDocument, deleteDocument,
  listVersions, getVersion, addVersion,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, assemble,
  instantiateSeedTemplate, renderDocument, RENDER_FORMATS, materializeCanvasToDocument,
  type DocStatus, type Provenance, type RenderFormat,
} from './documentsService.js';
import { listSeedTemplates } from './seedTemplates.js';
import { listArtifactTypes } from '../../host/artifactTypes.js';

const FEATURE = { toggleId: 'documents', label: 'Documents & Templates' };
const ORG = '/v1/host/openwop-app/documents/orgs/:orgId';

type Scope = 'workspace:read' | 'workspace:write';
const SUBJECT_KINDS: readonly SubjectKind[] = ['agent', 'user', 'project'];

/** Parse the `ownerSubject` query filter (`?ownerKind=project&ownerId=…`). */
function ownerFilter(req: Request): Subject | undefined {
  const kind = req.query.ownerKind;
  const id = req.query.ownerId;
  if (typeof kind === 'string' && (SUBJECT_KINDS as readonly string[]).includes(kind) && typeof id === 'string' && id) {
    return { kind: kind as SubjectKind, id };
  }
  return undefined;
}

export function registerDocumentsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // ───────────────────────── documents ────────────────────────────────────────
  app.get(`${ORG}/documents`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const kind = optionalString(req.query.kind);
      const statusQ = optionalString(req.query.status);
      const documents = await listDocuments(user.tenantId, orgId, {
        ...(kind ? { kind } : {}),
        ...(statusQ ? { status: statusQ as DocStatus } : {}),
        ...(ownerFilter(req) ? { ownerSubject: ownerFilter(req) } : {}),
      });
      res.json({ documents });
    } catch (err) { next(err); }
  });

  // Materialize a canvas/launch-studio artifact into a real document (ADR 0056) —
  // one-way; idempotent per canvas. Registered before `/documents/:documentId`.
  app.post(`${ORG}/documents/from-canvas`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const canvasId = requireString((req.body ?? {}).canvasId, 'canvasId');
      const result = await materializeCanvasToDocument(user.tenantId, orgId, canvasId, user.userId);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/documents`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provenance: Provenance = { producedBy: { kind: 'user', id: user.userId } };
      const doc = await createDocument({
        tenantId: user.tenantId, orgId,
        title: body.title, kind: body.kind, format: body.format,
        ownerSubject: body.ownerSubject, provenance, createdBy: user.userId,
      });
      res.status(201).json(doc);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/documents/:documentId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const doc = await getDocument(user.tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      const current = doc.currentVersionId ? await getVersion(user.tenantId, orgId, doc.documentId, doc.currentVersionId) : null;
      res.json({ ...doc, currentVersion: current });
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/documents/:documentId`, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Approval is privileged (ADR 0053 §Phase 1): promoting to approved/final
      // makes a document publicly shareable, so it requires `host:members:manage`,
      // not plain `workspace:write`. Lower-status edits stay at write.
      const promotesToShareable = body.status === 'approved' || body.status === 'final';
      const { user, orgId } = promotesToShareable
        ? await authorizeOrgScope(req, FEATURE, 'host:members:manage')
        : await authz(req, 'workspace:write');
      const doc = await updateDocument(user.tenantId, orgId, req.params.documentId, user.userId, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.ownerSubject !== undefined ? { ownerSubject: body.ownerSubject } : {}),
      });
      if (!doc) throw notFound(req.params.documentId);
      res.json(doc);
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/documents/:documentId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const ok = await deleteDocument(user.tenantId, orgId, req.params.documentId);
      if (!ok) throw notFound(req.params.documentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ───────────────────────── versions (immutable) ─────────────────────────────
  app.get(`${ORG}/documents/:documentId/versions`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const doc = await getDocument(user.tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      res.json({ versions: await listVersions(user.tenantId, orgId, req.params.documentId) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/documents/:documentId/versions`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const version = await addVersion(user.tenantId, orgId, req.params.documentId, {
        content: body.content,
        ...(optionalString(body.renderedMediaToken) ? { renderedMediaToken: optionalString(body.renderedMediaToken)! } : {}),
        producedBy: { kind: 'user', id: user.userId },
        ...(optionalString(body.idempotencyKey) ? { idempotencyKey: optionalString(body.idempotencyKey)! } : {}),
      });
      res.status(201).json(version);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/documents/:documentId/versions/:versionId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const v = await getVersion(user.tenantId, orgId, req.params.documentId, req.params.versionId);
      if (!v) throw new OpenwopError('not_found', 'Version not found.', 404, { versionId: req.params.versionId });
      res.json(v);
    } catch (err) { next(err); }
  });

  // ─── KB ingest compose: make a finished document retrievable (no new RAG store) ─
  app.post(`${ORG}/documents/:documentId/ingest-to-kb`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const doc = await getDocument(user.tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      const collectionId = requireString((req.body ?? {}).collectionId, 'collectionId');
      const current = doc.currentVersionId ? await getVersion(user.tenantId, orgId, doc.documentId, doc.currentVersionId) : null;
      if (!current) throw new OpenwopError('validation_error', 'Document has no content to ingest.', 400, {});
      const ingested = await ingestDocument(user.tenantId, orgId, user.userId, collectionId, { title: doc.title, text: current.content });
      res.status(201).json({ ok: true, document: ingested });
    } catch (err) { next(err); }
  });

  // ─── render the current version to PDF → Media token (ADR 0057; deterministic) ──
  app.post(`${ORG}/documents/:documentId/render`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const format = optionalString((req.body ?? {}).format) ?? 'pdf';
      if (!(RENDER_FORMATS as readonly string[]).includes(format)) throw new OpenwopError('validation_error', `Unsupported render format \`${format}\` — one of: ${RENDER_FORMATS.join(', ')}.`, 400, { field: 'format' });
      const result = await renderDocument(user.tenantId, orgId, req.params.documentId, user.userId, format as RenderFormat);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  // ───────────────────────── templates ────────────────────────────────────────
  app.get(`${ORG}/templates`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const kind = optionalString(req.query.kind);
      res.json({ templates: await listTemplates(user.tenantId, orgId, kind) });
    } catch (err) { next(err); }
  });

  // Registered host artifact types (ADR 0055) — the bindable `artifactTypeId` set.
  app.get(`${ORG}/artifact-types`, async (req, res, next) => {
    try {
      await authz(req, 'workspace:read');
      res.json({ artifactTypes: listArtifactTypes() });
    } catch (err) { next(err); }
  });

  // Built-in starter catalog (read-only) — registered BEFORE `/templates/:templateId`
  // so "catalog" isn't captured as a template id (Express first-match).
  app.get(`${ORG}/templates/catalog`, async (req, res, next) => {
    try {
      await authz(req, 'workspace:read');
      res.json({ catalog: listSeedTemplates(optionalString(req.query.kind)) });
    } catch (err) { next(err); }
  });

  // Instantiate a starter into the org as an editable template.
  app.post(`${ORG}/templates/from-catalog/:catalogId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const tmpl = await instantiateSeedTemplate(user.tenantId, orgId, req.params.catalogId, user.userId);
      res.status(201).json(tmpl);
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/templates`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tmpl = await createTemplate({
        tenantId: user.tenantId, orgId,
        name: body.name, kind: body.kind, outputFormat: body.outputFormat,
        promptBody: body.promptBody, promptRef: body.promptRef, parameters: body.parameters,
        outputSchema: body.outputSchema, artifactTypeId: body.artifactTypeId, createdBy: user.userId,
      });
      res.status(201).json(tmpl);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const tmpl = await getTemplate(user.tenantId, orgId, req.params.templateId);
      if (!tmpl) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.json(tmpl);
    } catch (err) { next(err); }
  });

  app.put(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tmpl = await updateTemplate(user.tenantId, orgId, req.params.templateId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.promptBody !== undefined ? { promptBody: body.promptBody } : {}),
        ...(body.parameters !== undefined ? { parameters: body.parameters } : {}),
        ...(body.outputSchema !== undefined ? { outputSchema: body.outputSchema } : {}),
        ...(body.artifactTypeId !== undefined ? { artifactTypeId: body.artifactTypeId } : {}),
      });
      if (!tmpl) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.json(tmpl);
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const ok = await deleteTemplate(user.tenantId, orgId, req.params.templateId);
      if (!ok) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // assemble (run-scoped generation floor — validate + render, NO LLM call here)
  app.post(`${ORG}/templates/:templateId/assemble`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const params = ((req.body ?? {}) as Record<string, unknown>).params ?? {};
      const result = await assemble(user.tenantId, orgId, req.params.templateId, params as Record<string, unknown>);
      res.json(result);
    } catch (err) { next(err); }
  });
}

function notFound(documentId: string): OpenwopError {
  return new OpenwopError('not_found', 'Document not found.', 404, { documentId });
}
