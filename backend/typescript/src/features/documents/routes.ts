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
import { authorizeOrgScope, requireFeatureEnabled, requireString, optionalString, tenantOf } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { getOrg, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { resolveSubjectAccess, levelSatisfies } from '../../host/subjectAccess.js';
import type { Subject, SubjectKind } from '../../host/subject.js';
import { ingestDocument } from '../kb/kbService.js';
import {
  listDocuments, getDocument, getDocumentByIdForTenant, createDocument, updateDocument, deleteDocument,
  listVersions, getVersion, addVersion,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, assemble,
  instantiateSeedTemplate, renderDocument, RENDER_FORMATS, materializeCanvasToDocument,
  type DocStatus, type Provenance, type RenderFormat,
} from './documentsService.js';
import { listSeedTemplates } from './seedTemplates.js';
import { markdownToHtml } from './render.js';
import { listArtifactTypes } from '../../host/artifactTypes.js';
import { listCanvasesForTenant, getCanvasForTenant, deleteCanvasForTenant } from '../../host/canvasSurface.js';

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

  // ADR 0350 follow-up (DOCS-2) — resolve a bare documentId to its org WITHOUT
  // the client fanning a getDocument probe across every org it belongs to. A
  // point lookup (docs are keyed by documentId), then the SAME membership gate
  // requireOrgScope applies — but against the RESOLVED org. Every failure is a
  // uniform 404 (a tenant member without org access must not learn the doc
  // exists). Distinct path segment (`/locate/` vs `/orgs/`) — no route shadow.
  app.get('/v1/host/openwop-app/documents/locate/:documentId', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      // ADR 0508 Phase 2 — this handler HAND-ROLLS the `requireOrgScope` logic
      // (point lookup, then the same tenant + scope check) because the org is
      // RESOLVED from the document rather than taken from the path, so the shared
      // guard — which reads `req.params.orgId` — cannot be called directly.
      //
      // It is therefore a SECOND COPY of the guard and carried the identical
      // home-vs-active tenant defect. It is flipped here in lockstep. The tenant
      // MUST come from `tenantOf(req)` (ACTIVE), exactly as the shared guard now
      // does; `caller` supplies only the SUBJECT. Keep these two in step — a
      // structural gate pins that this file names `tenantOf`.
      const caller = await resolveCallerUser(req);
      const activeTenant = tenantOf(req);
      const d = await getDocumentByIdForTenant(activeTenant, req.params.documentId);
      const org = d ? await getOrg(d.orgId) : null;
      if (!d || !org || org.tenantId !== activeTenant) throw notFound(req.params.documentId);
      const access = await resolveEffectiveAccess(activeTenant, { subject: caller.userId, orgId: d.orgId });
      if (!access.scopes.includes('workspace:read')) throw notFound(req.params.documentId);
      // ADR 0610 D3′ — a project-owned doc must not resolve its org to a non-member.
      await assertOwnerReadable(activeTenant, d.ownerSubject, caller.userId, req.params.documentId);
      res.json({ orgId: d.orgId });
    } catch (err) { next(err); }
  });

  // ───────────────────────── documents ────────────────────────────────────────
  app.get(`${ORG}/documents`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:read');
      const kind = optionalString(req.query.kind);
      const statusQ = optionalString(req.query.status);
      const documents = await listDocuments(tenantId, orgId, {
        ...(kind ? { kind } : {}),
        ...(statusQ ? { status: statusQ as DocStatus } : {}),
        ...(ownerFilter(req) ? { ownerSubject: ownerFilter(req) } : {}),
      });
      // ADR 0610 D3′ — drop project-owned rows the caller cannot READ (a private
      // project's docs must not enumerate to a non-member org viewer). One seam
      // call per owned row; null ⇒ not membership-scoped ⇒ keep.
      const visible = (await Promise.all(documents.map(async (d) => {
        if (!d.ownerSubject) return d;
        const level = await resolveSubjectAccess(tenantId, d.ownerSubject, user.userId);
        return level !== null && !levelSatisfies(level, 'read') ? null : d;
      }))).filter((d): d is NonNullable<typeof d> => d !== null);
      res.json({ documents: visible });
    } catch (err) { next(err); }
  });

  // The tenant's canvases as materialization sources (ADR 0314 — the "From a
  // canvas" picker; replaces typing a raw canvas id). Documents-toggle-gated
  // like the materialize route it feeds: `materializeCanvasToDocument` works
  // for ANY canvas type, so the picker doesn't depend on editor toggles.
  app.get(`${ORG}/canvas-sources`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:read');
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      const rows = await listCanvasesForTenant(tenantId);
      // The picker shows the newest slice, not an unbounded dump — a canvas-
      // heavy tenant would otherwise ship thousands of rows into a modal.
      // `q` (ADR 0316) searches the WHOLE tenant set before the cap, so the
      // slice is never a dead end; `total` keeps the truncation honest.
      const filtered = q
        ? rows.filter((c) => (c.name ?? '').toLowerCase().includes(q) || c.canvasTypeId.toLowerCase().includes(q))
        : rows;
      res.json({ canvases: filtered.slice(0, 200), total: filtered.length });
    } catch (err) { next(err); }
  });

  // Delete a canvas from the unified Documents list (ADR 0319 — the Canvases
  // browser folded in here). REUSES the single `deleteCanvasForTenant` cascade
  // owner (version + idem) — NOT a second mutation path — so a canvas is
  // deletable from Documents even when its type toggle is OFF or its pack was
  // uninstalled (the per-type editor DELETE 404s then, stranding the row). Gated
  // by the `documents` toggle + workspace:write; tenant-scoped (404 on
  // absent/cross-tenant). Relocated verbatim from the removed canvases feature.
  app.delete(`${ORG}/canvases/:canvasId`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:write');
      const canvas = await getCanvasForTenant(tenantId, req.params.canvasId);
      if (!canvas) throw new OpenwopError('not_found', `canvas '${req.params.canvasId}' not found`, 404);
      // WF-SHARE-3 — the share-link purge that used to sit here (a hand-kept
      // `canvas.app-builder` → `app_builder_canvas` mapping) is GONE: it rides
      // `onCanvasDeleted`, fired by `deleteCanvasForTenant` below, so every
      // deleter cascades and there is one mapping instead of three.
      const deleted = await deleteCanvasForTenant(tenantId, req.params.canvasId);
      if (!deleted) throw new OpenwopError('not_found', `canvas '${req.params.canvasId}' not found`, 404);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // Materialize a canvas/launch-studio artifact into a real document (ADR 0056) —
  // one-way; idempotent per canvas. Registered before `/documents/:documentId`.
  app.post(`${ORG}/documents/from-canvas`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const canvasId = requireString((req.body ?? {}).canvasId, 'canvasId');
      const result = await materializeCanvasToDocument(tenantId, orgId, canvasId, user.userId);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/documents`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      // DOCTPL-8 (the cheap coherent slice of the templates identity crisis) —
      // an OPTIONAL doc→template link, written at create time because it is
      // unbackfillable afterwards. VALIDATED to exist in this org so a client
      // cannot mint a dangling or cross-org link; absent stays absent.
      let templateId: string | undefined;
      if (body.templateId !== undefined) {
        if (typeof body.templateId !== 'string' || !body.templateId.trim()) {
          throw new OpenwopError('validation_error', '`templateId` MUST be a non-empty string when supplied.', 400, { field: 'templateId' });
        }
        const tmpl = await getTemplate(tenantId, orgId, body.templateId);
        if (!tmpl) throw new OpenwopError('not_found', 'Template not found in this organization.', 404, { templateId: body.templateId });
        templateId = tmpl.templateId;
      }
      const provenance: Provenance = { producedBy: { kind: 'user', id: user.userId }, ...(templateId ? { templateId } : {}) };
      const doc = await createDocument({
        tenantId, orgId,
        title: body.title, kind: body.kind, format: body.format,
        ownerSubject: body.ownerSubject, provenance, createdBy: user.userId,
        ...(templateId ? { templateId } : {}),
      });
      res.status(201).json(doc);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/documents/:documentId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:read');
      const doc = await getDocument(tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      await assertOwnerReadable(tenantId, doc.ownerSubject, user.userId, req.params.documentId);
      const current = doc.currentVersionId ? await getVersion(tenantId, orgId, doc.documentId, doc.currentVersionId) : null;
      res.json({ ...doc, currentVersion: current });
    } catch (err) { next(err); }
  });

  // ADR 0643 / `KBC-4` — the three WRITE by-id doors (this PATCH, the DELETE
  // below, and `POST .../versions`) deliberately do NOT call `assertOwnerReadable`.
  // Recorded as a decision because an adversarial review asked for it:
  //
  //  1. The refusal population is EMPTY of attackers. All three gate on
  //     `workspace:write` in the path org; `resolveOwnerSubject:233` pins an owning
  //     project's org EQUAL to the document's org at create time; `levelFor:356`
  //     returns `'write'` to any `workspace:write` holder in that org BEFORE
  //     visibility is consulted; and `agent`/`user` ownerSubjects have no registered
  //     resolver, so they answer `null` ⇒ pass. The only branch that can refuse is
  //     `getProject → null`, i.e. the owning project was deleted. Adding the gate
  //     would therefore block nobody who is not already entitled.
  //  2. In that one population the gate has NO EXIT, and this codebase has already
  //     ruled against exactly that trade: `deleteProject` releases a KB collection's
  //     `boundSubject` BEFORE clearing the project because `resolveSubjectAccess`
  //     "cannot distinguish 'this project denies you' from 'this project is gone' —
  //     both are `'none'`. Leaving it would turn the collection into unreachable dead
  //     data for everyone, which is the gate-with-no-exit shape and strictly worse
  //     than the leak the stamp closes" (ADR 0608 D4, `projectsService.ts:484-492`).
  //     Documents are NOT cascaded on project delete, so gating PATCH + DELETE would
  //     strand such a row permanently — unreadable, un-renderable, un-reassignable
  //     and UNDELETABLE, content still on disk. PATCH re-pointing `ownerSubject` IS
  //     the exit, and DELETE is the cleanup.
  //  3. Neither egresses content: PATCH returns the row projection, DELETE returns
  //     204, `POST versions` writes content IN. The read/egress doors — GET, versions
  //     list, version-by-id, KB ingest, render and promote-html — all gate.
  //
  // Both halves are test-pinned (`test/kbc4-documents-ingest-to-kb-idor.test.ts`,
  // "the write doors" block): a writer is never refused by visibility, and a stranded
  // document stays recoverable + cleanable. If the first goes red, premise 1 is
  // falsified and these three MUST be gated.
  app.patch(`${ORG}/documents/:documentId`, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Approval is privileged (ADR 0053 §Phase 1): promoting to approved/final
      // makes a document publicly shareable, so it requires `host:members:manage`,
      // not plain `workspace:write`. Lower-status edits stay at write.
      const promotesToShareable = body.status === 'approved' || body.status === 'final';
      const { user, orgId, tenantId } = promotesToShareable
        ? await authorizeOrgScope(req, FEATURE, 'host:members:manage')
        : await authz(req, 'workspace:write');
      // ADR 0350 Phase 3 — a promotedCanvasId MUST reference a real canvas the
      // caller's tenant owns (getCanvasForTenant is tenant-scoped → null when
      // absent or cross-tenant), so the stored one-way link can never dangle or
      // point at another tenant's canvas.
      if (body.promotedCanvasId !== undefined) {
        const cid = body.promotedCanvasId;
        if (typeof cid !== 'string' || !(await getCanvasForTenant(tenantId, cid))) {
          throw new OpenwopError('validation_error', '`promotedCanvasId` must reference a canvas you own.', 400, { field: 'promotedCanvasId' });
        }
      }
      const doc = await updateDocument(tenantId, orgId, req.params.documentId, user.userId, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.ownerSubject !== undefined ? { ownerSubject: body.ownerSubject } : {}),
        ...(body.promotedCanvasId !== undefined ? { promotedCanvasId: body.promotedCanvasId } : {}),
      });
      if (!doc) throw notFound(req.params.documentId);
      res.json(doc);
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/documents/:documentId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const ok = await deleteDocument(tenantId, orgId, req.params.documentId);
      if (!ok) throw notFound(req.params.documentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ───────────────────────── versions (immutable) ─────────────────────────────
  app.get(`${ORG}/documents/:documentId/versions`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:read');
      const doc = await getDocument(tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      await assertOwnerReadable(tenantId, doc.ownerSubject, user.userId, req.params.documentId);
      res.json({ versions: await listVersions(tenantId, orgId, req.params.documentId) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/documents/:documentId/versions`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const version = await addVersion(tenantId, orgId, req.params.documentId, {
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
      const { user, orgId, tenantId } = await authz(req, 'workspace:read');
      // ADR 0610 D3′ — load the parent doc for the owner gate BEFORE serving a
      // version, else the version door leaks a private project's content past the
      // by-id door's check.
      const doc = await getDocument(tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      await assertOwnerReadable(tenantId, doc.ownerSubject, user.userId, req.params.documentId);
      const v = await getVersion(tenantId, orgId, req.params.documentId, req.params.versionId);
      if (!v) throw new OpenwopError('not_found', 'Version not found.', 404, { versionId: req.params.versionId });
      res.json(v);
    } catch (err) { next(err); }
  });

  // ─── KB ingest compose: make a finished document retrievable (no new RAG store) ─
  app.post(`${ORG}/documents/:documentId/ingest-to-kb`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const doc = await getDocument(tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      // ADR 0643 / `KBC-4` — one of FIVE by-id doors in this file that skipped the
      // ADR 0610 D3' membership check. CORRECTED: the first version of this comment
      // called it "the ONE door ... its four siblings call", which was false and is
      // how a live leak survived the fix. Counted by CALL GRAPH, not by the filed
      // gap's wording: the file registers nine `documents/:documentId` doors (ten
      // with `/locate/`) and holds five owner-check call sites. The five that
      // skipped it were PATCH, DELETE, POST versions, `render` and `promote-html`;
      // `promote-html` was the live one (see its comment below).
      //
      // What is specific to THIS door: it does not merely read, it COPIES the
      // current version's text into a caller-named KB collection the caller then
      // reads back — so the copy escapes durably, past the guard. Its own reachable
      // refusal is narrow, because it gates on `workspace:write` and
      // `projectsService.levelFor:356` returns `'write'` (⇒ read) to any
      // `workspace:write` holder in the owning org before visibility is consulted:
      // a document whose owning project has been DELETED (no document cascade, and
      // `resolveProjectAccess` cannot tell "denied" from "gone"). Ruling the filed
      // exploit out from that fact alone was the error — it only ever described
      // this door's scope, not the class's.
      // Witnesses for every door: `test/kbc4-documents-ingest-to-kb-idor.test.ts`.
      await assertOwnerReadable(tenantId, doc.ownerSubject, user.userId, req.params.documentId);
      const collectionId = requireString((req.body ?? {}).collectionId, 'collectionId');
      const current = doc.currentVersionId ? await getVersion(tenantId, orgId, doc.documentId, doc.currentVersionId) : null;
      if (!current) throw new OpenwopError('validation_error', 'Document has no content to ingest.', 400, {});
      const ingested = await ingestDocument(tenantId, orgId, user.userId, collectionId, { title: doc.title, text: current.content }, {}, { subject: user.userId }); // KBC-1 — the DESTINATION collection has a subject gate too: copying a document into a project-bound corpus is a write into that project's corpus.
      res.status(201).json({ ok: true, document: ingested });
    } catch (err) { next(err); }
  });

  // ─── render the current version to PDF → Media token (ADR 0057; deterministic) ──
  app.post(`${ORG}/documents/:documentId/render`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const format = optionalString((req.body ?? {}).format) ?? 'pdf';
      if (!(RENDER_FORMATS as readonly string[]).includes(format)) throw new OpenwopError('validation_error', `Unsupported render format \`${format}\` — one of: ${RENDER_FORMATS.join(', ')}.`, 400, { field: 'format' });
      // ADR 0643 / `KBC-4` — this door loaded NO row at all, so it had neither the
      // uniform notFound nor the owner gate, and its egress is the worst of the
      // set: a durable PDF **Media token** of the same body, which outlives the
      // request (measured before the fix: a real `renderedMediaToken` + `/assets/...`
      // URL for a document the GET door 404s). The gate is applied HERE rather than
      // inside `renderDocument` because the service is also the workflow surface's
      // (`documents/surface.ts:105`), which passes a `runId` as actor and has no
      // caller subject to resolve — a run's authority is gated at the surface, not
      // by a user-membership seam.
      const doc = await getDocument(tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      await assertOwnerReadable(tenantId, doc.ownerSubject, user.userId, req.params.documentId);
      const result = await renderDocument(tenantId, orgId, req.params.documentId, user.userId, format as RenderFormat);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  // ─── promote to a rich canvas.document (ADR 0350 Phase 3) ────────────────────
  // Returns the current version's markdown rendered to HTML. The client turns it
  // into ProseMirror JSON via the document-editor schema, seeds a new
  // `canvas.document`, then PATCHes `promotedCanvasId` back here (one-way link).
  // Read-only itself (the write is the client's canvas create + the PATCH).
  app.post(`${ORG}/documents/:documentId/promote-html`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:read');
      const doc = await getDocument(tenantId, orgId, req.params.documentId);
      if (!doc) throw notFound(req.params.documentId);
      // ADR 0643 / `KBC-4` — THE LIVE LEAK of this class. This door is
      // `workspace:read`, so unlike the write doors it is reachable by a caller
      // `levelFor` walks all the way to `'none'`: a non-member org VIEWER on a
      // `private` project. The GET door 404s that row and the list door filters
      // it out, while this one returned `markdownToHtml(current.content)` — the
      // WHOLE body — plus the title. Measured before the fix:
      // `{"html":"<p>BOARD-ONLY: ...</p>","title":"Merger plan"}` to a caller with
      // no project membership. That is the exploit the assessment filed, and the
      // first pass wrongly ruled it out by testing only `ingest-to-kb`.
      await assertOwnerReadable(tenantId, doc.ownerSubject, user.userId, req.params.documentId);
      const current = doc.currentVersionId ? await getVersion(tenantId, orgId, doc.documentId, doc.currentVersionId) : null;
      res.json({ html: markdownToHtml(current?.content ?? ''), title: doc.title, promotedCanvasId: doc.promotedCanvasId ?? null });
    } catch (err) { next(err); }
  });

  // ───────────────────────── templates ────────────────────────────────────────
  app.get(`${ORG}/templates`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const kind = optionalString(req.query.kind);
      res.json({ templates: await listTemplates(tenantId, orgId, kind) });
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
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const tmpl = await instantiateSeedTemplate(tenantId, orgId, req.params.catalogId, user.userId);
      res.status(201).json(tmpl);
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/templates`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tmpl = await createTemplate({
        tenantId, orgId,
        name: body.name, kind: body.kind, outputFormat: body.outputFormat,
        promptBody: body.promptBody, promptRef: body.promptRef, parameters: body.parameters,
        outputSchema: body.outputSchema, artifactTypeId: body.artifactTypeId, createdBy: user.userId,
      });
      res.status(201).json(tmpl);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const tmpl = await getTemplate(tenantId, orgId, req.params.templateId);
      if (!tmpl) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.json(tmpl);
    } catch (err) { next(err); }
  });

  app.put(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tmpl = await updateTemplate(tenantId, orgId, req.params.templateId, {
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
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const ok = await deleteTemplate(tenantId, orgId, req.params.templateId);
      if (!ok) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // assemble (run-scoped generation floor — validate + render, NO LLM call here)
  app.post(`${ORG}/templates/:templateId/assemble`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const params = ((req.body ?? {}) as Record<string, unknown>).params ?? {};
      const result = await assemble(tenantId, orgId, req.params.templateId, params as Record<string, unknown>);
      res.json(result);
    } catch (err) { next(err); }
  });
}

function notFound(documentId: string): OpenwopError {
  return new OpenwopError('not_found', 'Document not found.', 404, { documentId });
}

/** ADR 0610 D3′ / CPC-15 — a document carrying a project/user `ownerSubject` is
 *  membership-scoped: the org gate above (`workspace:read`) is NOT sufficient. Ask
 *  the ONE `host/subjectAccess.ts` seam whether the caller may READ this owner
 *  subject. A `null` result ⇒ NOT membership-scoped (no `user`-kind resolver;
 *  org-owned docs carry no ownerSubject) ⇒ the org gate stands. Otherwise require
 *  READ, and refuse as a uniform 404 (no existence leak — the KB door's posture). */
async function assertOwnerReadable(
  tenantId: string,
  ownerSubject: Subject | undefined,
  caller: string,
  documentId: string,
): Promise<void> {
  if (!ownerSubject) return;
  const level = await resolveSubjectAccess(tenantId, ownerSubject, caller);
  if (level !== null && !levelSatisfies(level, 'read')) throw notFound(documentId);
}
