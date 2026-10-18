/**
 * Documents & Templates feature service (host-extension, ADR 0053) — the store of
 * versioned, provenance-stamped business documents (SOW/PRD/RFP/Epic-Brief/board-
 * agenda) + a template library that BINDS the prompt machinery to named kinds.
 *
 * Single-owner composition (no parallel systems):
 *   - bytes (rendered pdf/slides) → Media tokens, never stored inline here;
 *   - ownership → the Subject model (`ownerSubject`, ADR 0045/0046) — a document
 *     may belong to a `project`/`user`/`agent` subject, org-level when absent. A
 *     `kind:'project'` owner's org is DERIVED via `resolveSubjectOrg`, never trusted
 *     from the request (the ADR 0046 read-privacy seam);
 *   - artifact-types (RFC 0071/0075) ARE implemented host-side (ADR 0055): a
 *     bound `artifactTypeId` is validated and the generate node emits a typed
 *     `artifact.created`. Output is ALSO validated against the template-owned
 *     `outputSchema` (the two checks are complementary — this reconciles the
 *     prior stale "NOT implemented" caveat with `feature.ts`).
 *
 * Generation is run-scoped (the KB §Correction lesson): the route floor here is
 * assemble + validate; the actual LLM write happens in a workflow node / agent turn
 * (feature.documents.nodes). Bytes are durable in `documents:version.content`.
 */

import { notifyDocumentVersionAdded } from '../../host/documentVersionObservers.js';
import { resolveCanvasTypeAccess } from '../../host/canvasTypeOwnership.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import { randomUUID } from 'node:crypto';
import { insertOwnedOrConflict } from '../../host/ownedInsert.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { resolveSubjectOrg } from '../../host/subjectOrgScope.js';
import type { Subject, SubjectKind } from '../../host/subject.js';
import { getUser } from '../users/usersService.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { getSeedTemplate } from './seedTemplates.js';
import { renderMarkdownToPdf, renderMarkdownToPptx, renderMarkdownToCsv, renderMarkdownToDocx, renderMarkdownToEpub, renderMarkdownToOdt, renderMarkdownToLatex, probeImageDims, type ExportImageResolver } from './render.js';
import { resolveMediaAsset, storeMediaAsset } from '../../host/inMemorySurfaces.js';
import * as mediaStorage from '../media/mediaStorage.js';
import { createAsset } from '../media/mediaService.js';
import { assertNoRetentionHold } from '../../host/retentionHold.js';
import { createLogger } from '../../observability/logger.js';
import { isRegisteredArtifactType } from '../../host/artifactTypes.js';
import { getCanvasForCaller } from '../../host/canvasSurface.js';
import { resolveSubjectAccess, levelSatisfies } from '../../host/subjectAccess.js';

const log = createLogger('features.documents');

// ─── vocabulary ──────────────────────────────────────────────────────────────

export type DocFormat = 'markdown' | 'pdf' | 'slides' | 'diagram' | 'sheet' | 'doc';
const DOC_FORMATS: readonly DocFormat[] = ['markdown', 'pdf', 'slides', 'diagram', 'sheet', 'doc'];

export type DocStatus = 'draft' | 'in-review' | 'approved' | 'final';
export const DOC_STATUSES: readonly DocStatus[] = ['draft', 'in-review', 'approved', 'final'];
/** Statuses whose content is safe to expose on the public share surface. */
export const SHAREABLE_STATUSES: readonly DocStatus[] = ['approved', 'final'];

/**
 * Allowed status transitions (the CMS-style lifecycle, ADR 0053). Forward through
 * draft → in-review → approved → final, with demotions back to draft/in-review for
 * revisions and a same-status no-op (idempotent PATCH). Promotions to a shareable
 * status are additionally gated on `host:members:manage` at the route. Forbidding
 * arbitrary jumps keeps the lifecycle (and the public-share gate) meaningful.
 */
const STATUS_TRANSITIONS: Record<DocStatus, readonly DocStatus[]> = {
  draft: ['draft', 'in-review', 'approved'],
  'in-review': ['in-review', 'draft', 'approved'],
  approved: ['approved', 'final', 'in-review', 'draft'],
  final: ['final', 'approved', 'draft'],
};

/** Seeded business-document kinds — an OPEN vocabulary (any non-empty kebab tag is
 *  accepted), mirroring artifact-type open registration. */
export const SEEDED_KINDS = ['sow', 'prd', 'rfp', 'epic-brief', 'board-agenda', 'board-update', 'status-report', 'doc'] as const;

const SUBJECT_KINDS: readonly SubjectKind[] = ['agent', 'user', 'project'];

// ─── records ─────────────────────────────────────────────────────────────────

export interface Provenance {
  producedBy: { kind: 'user' | 'agent' | 'run'; id: string };
  runId?: string;
  nodeId?: string;
  templateId?: string;
  templateVersion?: number;
  /** ADR 0853 D2 — where a recorded decision was made (a message, an approval,
   *  a meeting, a drift finding), so the record links back to it. */
  source?: { kind: string; ref: string; link?: string };
}

export interface DocumentRecord {
  documentId: string;
  tenantId: string;
  orgId: string;
  /** Optional finer owner within the org (ADR 0045/0046). Absent ⇒ org-level. */
  ownerSubject?: Subject;
  kind: string;
  format: DocFormat;
  title: string;
  status: DocStatus;
  /** Deterministic id of the current (latest) version, or undefined before any. */
  currentVersionId?: string;
  /** ADR 0838 D2 — the version an approver published. The public share serves
   *  THIS version, never `currentVersionId`, so a version written after approval
   *  stays private until someone with `host:members:manage` approves again.
   *  Set when status moves to approved/final; cleared when it leaves them.
   *  Absent on rows approved before ADR 0838 (see `publicVersionIdOf`). */
  approvedVersionId?: string;
  templateId?: string;
  /** ADR 0350 Phase 3 — set once this markdown doc has been promoted to a rich
   *  `canvas.document`. Makes promotion one-way + idempotent (re-promote opens
   *  this canvas) and drives the "Opened as a rich document" link. */
  promotedCanvasId?: string;
  provenance: Provenance;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  /** Deterministic — `${documentId}:${version}`; idempotent on replay/retry. */
  versionId: string;
  documentId: string;
  tenantId: string;
  orgId: string;
  version: number;
  content: string;
  /** A Media (RFC 0055) token for a rendered non-markdown representation. */
  renderedMediaToken?: string;
  /** WF-DOC-4 — per-format render stamps for the DURABLE formats (pdf/slides/
   *  sheet). A version is immutable and every renderer deterministic, so ONE
   *  stored asset per (version, format) is the whole truth; a re-render/replay
   *  returns the stamped token instead of minting a duplicate library asset or
   *  rewriting `renderedMediaToken` (which invalidated shared PDF links). */
  renderedTokens?: Record<string, { token: string; sizeBytes: number }>;
  producedBy: Provenance['producedBy'];
  /** Caller-supplied dedup key (a retried run reuses the same version). */
  idempotencyKey?: string;
  createdAt: string;
}

export interface DocumentTemplate {
  templateId: string;
  tenantId: string;
  orgId: string;
  name: string;
  kind: string;
  outputFormat: DocFormat;
  /** The generator body — `{{param}}` placeholders filled at assemble time. */
  promptBody: string;
  /** Optional RFC 0028 PromptRef (`prompt:templateId[@version]`) into the library —
   *  stored for forward binding; v1 renders from `promptBody`. */
  promptRef?: string;
  /** JSON-Schema-ish param spec: { required: string[], properties: {name:{type}} }. */
  parameters: TemplateParams;
  /** Feature-owned schema the generated content is validated against (the output
   *  contract is the template's, not the wire's). */
  outputSchema?: Record<string, unknown>;
  /** Bound host artifact type (ADR 0055 — validated as REGISTERED at write;
   *  generation from a bound template emits a typed `artifact.created`). */
  artifactTypeId?: string;
  /** WF-DOC-9 — the seed-catalog id this template was instantiated from (the
   *  ADR 0516 §Provenance lesson, ported from the forms `originTemplate` lane).
   *  Stamped at COPY time because it is unbackfillable: instantiation copies,
   *  so once the row exists nothing can recover which starter produced it.
   *  Absent on hand-authored templates; server-stamped only (never from a
   *  request body). */
  catalogId?: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateParams {
  required: string[];
  properties: Record<string, { type?: string; description?: string }>;
}

// ─── caps (bound every stored field — the Media/CRM/CMS lesson) ───────────────

const MAX = {
  docsPerOrg: 5_000,
  templatesPerOrg: 500,
  versionsPerDoc: 200,
  contentBytes: 1_000_000,
  promptBodyBytes: 100_000,
  title: 300,
  idempotencyKey: 200,
} as const;

const docs = new DurableCollection<DocumentRecord>('documents:doc', (d) => d.documentId);

/** ADR 0838 A2 — test seam: runs between a document writer's read and its swap,
 *  so a witness can interleave a second writer deterministically (the in-memory
 *  store serialises `Promise.all`, which proves nothing). */
let beforeDocSwapHook: ((documentId: string) => Promise<void>) | undefined;
export function __setBeforeDocSwapHook(hook: ((documentId: string) => Promise<void>) | undefined): void {
  beforeDocSwapHook = hook;
}

/**
 * ADR 0838 A2 — the ONE way to change an existing `documents:doc` row. A
 * compare-and-swap retry loop over the FRESH row: `fn` sees the stored row and
 * returns the next one (or `null` to leave it). Every writer after the insert
 * goes through here — PATCH, the version pointer, the canvas-ref cascade and
 * the subject eraser — so none can land a stale row over another's change.
 * `fn` may throw to refuse; it is re-run on every retry, so it must be pure
 * over its input. Tenant/org scoping is the caller's (it has the row).
 */
export async function mutateDocument(
  documentId: string,
  fn: (fresh: DocumentRecord) => DocumentRecord | null | Promise<DocumentRecord | null>,
): Promise<DocumentRecord | null> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const fresh = await docs.get(documentId);
    if (!fresh) return null;
    const next = await fn(fresh);
    if (!next) return fresh;
    if (beforeDocSwapHook) await beforeDocSwapHook(documentId);
    if (await docs.compareAndSwap(fresh, next)) return next;
  }
  throw new OpenwopError('conflict', 'Could not update the document (too many concurrent writes).', 409, { documentId });
}

/** Test seam — write a document row verbatim (e.g. a LEGACY approved row with
 *  no `approvedVersionId`). */
export async function _putDocumentForTest(d: DocumentRecord): Promise<void> {
  await docs.put(d);
}

const versions = new DurableCollection<DocumentVersion>('documents:version', (v) => v.versionId);

/** Test seam — write a version row in a LEGACY shape (e.g. a pre-WF-DOC-4 row
 *  with `renderedMediaToken` but no `renderedTokens` map) so migration-honoring
 *  branches can be exercised without reaching into the collection. */
export async function _putVersionForTest(v: DocumentVersion): Promise<void> {
  await versions.put(v);
}
const templates = new DurableCollection<DocumentTemplate>('documents:template', (t) => t.templateId);
// ADR 0056 — deterministic (tenant,org,canvas) → documentId mapping so re-materializing
// a canvas updates its document (a new version) rather than spawning duplicates.
/** WF-DOC-7 — `tenantId` is a REAL field on the row. It used to live only
 *  inside the composite `key` (`${tenantId}:${orgId}:${canvasId}` — unparseable,
 *  tenant ids contain ':'), so BOTH teardown probes missed these rows and they
 *  survived tenant deletion permanently. With the field, `purgeTenantHostExt`'s
 *  `jsonTenantId` probe reaches new rows. Legacy rows (written before this)
 *  remain field-less and teardown-invisible — additive fix, no backfill: the
 *  stale-mapping self-heal on read tolerates a missing/purged mapping. */
const canvasMap = new DurableCollection<{ key: string; tenantId?: string; documentId: string }>('documents:canvasmap', (m) => m.key);

// ─── helpers ─────────────────────────────────────────────────────────────────

function boundString(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    if (!required) return '';
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  if (value.length > max) throw new OpenwopError('validation_error', `Field \`${field}\` exceeds ${max} chars.`, 400, { field });
  return value;
}

function asKind(value: unknown): string {
  const k = boundString(value, 'kind', 64);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(k)) throw new OpenwopError('validation_error', '`kind` MUST be a kebab tag [a-z0-9-].', 400, { field: 'kind' });
  return k;
}

function asFormat(value: unknown): DocFormat {
  if (typeof value !== 'string' || !(DOC_FORMATS as readonly string[]).includes(value)) {
    throw new OpenwopError('validation_error', `\`format\` MUST be one of: ${DOC_FORMATS.join(', ')}.`, 400, { field: 'format' });
  }
  return value as DocFormat;
}

/** Parse + validate an optional ownerSubject; for a `project` subject, assert it
 *  resolves to THIS org (the ADR 0046 derived-org invariant — no drift, no IDOR). */
async function resolveOwnerSubject(value: unknown, tenantId: string, orgId: string): Promise<Subject | undefined> {
  if (value == null) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  const id = raw.id;
  if (typeof kind !== 'string' || !(SUBJECT_KINDS as readonly string[]).includes(kind) || typeof id !== 'string' || id.trim().length === 0) {
    throw new OpenwopError('validation_error', '`ownerSubject` MUST be `{kind: agent|user|project, id}`.', 400, { field: 'ownerSubject' });
  }
  const subject: Subject = { kind: kind as SubjectKind, id };
  // Validate the owner exists and belongs to THIS tenant (a cross-tenant or
  // dangling owner is a uniform 404 — no existence leak). For a project the org
  // must also match (the ADR 0046 derived-org invariant). This keeps `ownerSubject`
  // an honest reference, not an arbitrary client-supplied tag.
  if (subject.kind === 'project') {
    const subjectOrg = await resolveSubjectOrg(tenantId, subject);
    if (subjectOrg !== orgId) {
      throw new OpenwopError('not_found', 'Owning project not found in this organization.', 404, {});
    }
  } else if (subject.kind === 'user') {
    const u = await getUser(subject.id);
    if (!u || u.tenantId !== tenantId) {
      throw new OpenwopError('not_found', 'Owning user not found in this tenant.', 404, {});
    }
  } else {
    const a = await getRosterEntry(tenantId, subject.id);
    if (!a) {
      throw new OpenwopError('not_found', 'Owning agent not found in this tenant.', 404, {});
    }
  }
  return subject;
}

function sameOwner(a: Subject | undefined, b: Subject | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.id === b.id;
}

// ─── documents ───────────────────────────────────────────────────────────────

export async function getDocument(tenantId: string, orgId: string, documentId: string): Promise<DocumentRecord | null> {
  const d = await docs.get(documentId);
  return d && d.tenantId === tenantId && d.orgId === orgId ? d : null;
}

/** Find a document by id within a tenant (any org) — for the launch-studio document
 *  resolver seam (ADR 0056), which has only tenant scope. */
export async function getDocumentByIdForTenant(tenantId: string, documentId: string): Promise<DocumentRecord | null> {
  const d = await docs.get(documentId);
  return d && d.tenantId === tenantId ? d : null;
}

/** All documents in a tenant, ACROSS orgs — for the cross-source artifact Library
 *  (ADR 0083). Access is enforced PER-ORG by the caller (artifactProjection.listArtifacts),
 *  never trusted here. */
export async function listDocumentsForTenant(tenantId: string): Promise<DocumentRecord[]> {
  return (await docs.list()).filter((d) => d.tenantId === tenantId);
}

/** ADR 0839 D2 — the documents `owner` OWNS in this tenant (exact `ownerSubject`),
 *  for the owner's delete cascade. Tenant-filtered before the owner match. */
export async function listDocumentsOwnedBy(tenantId: string, owner: Subject): Promise<DocumentRecord[]> {
  return (await listDocumentsForTenant(tenantId)).filter((d) => d.ownerSubject !== undefined && sameOwner(d.ownerSubject, owner));
}

/**
 * ADR 0350 Phase 3 follow-up (DOCS-1) — a deleted `canvas.document` must not
 * leave `promotedCanvasId` dangling on its source markdown doc. Called from the
 * feature's `onCanvasDeleted` hook (fired AFTER the canvas row is gone); clears
 * the field on every referencing doc in the tenant (set-once ⇒ at most one, but
 * sweep-all is the safe shape). A lifecycle cascade, not a caller PATCH
 * (updateDocument's set-once/ownership rules don't apply to unsetting a
 * now-dead reference) — but still a CAS through `mutateDocument` (ADR 0838 A2). The full-collection scan matches the store's
 * existing access pattern (listDocuments) and canvas deletes are rare.
 */
export async function clearPromotedCanvasRefs(tenantId: string, canvasId: string): Promise<number> {
  const referencing = (await docs.list()).filter((d) => d.tenantId === tenantId && d.promotedCanvasId === canvasId);
  for (const d of referencing) {
    await mutateDocument(d.documentId, (fresh) => {
      if (fresh.tenantId !== tenantId || fresh.promotedCanvasId !== canvasId) return null;
      const next: DocumentRecord = { ...fresh, updatedAt: new Date().toISOString() };
      delete next.promotedCanvasId;
      return next;
    });
  }
  return referencing.length;
}

export async function listDocuments(
  tenantId: string,
  orgId: string,
  filter?: { kind?: string; status?: DocStatus; ownerSubject?: Subject | null },
): Promise<DocumentRecord[]> {
  const all = await docs.list();
  return all
    .filter((d) => d.tenantId === tenantId && d.orgId === orgId)
    .filter((d) => (filter?.kind ? d.kind === filter.kind : true))
    .filter((d) => (filter?.status ? d.status === filter.status : true))
    .filter((d) => (filter?.ownerSubject ? sameOwner(d.ownerSubject, filter.ownerSubject) : true))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createDocument(input: {
  tenantId: string; orgId: string; title: unknown; kind: unknown; format?: unknown;
  ownerSubject?: unknown; templateId?: string; provenance: Provenance; createdBy: string; documentId?: string;
}): Promise<DocumentRecord> {
  // Idempotent on a caller-supplied deterministic id (mirrors cmsService.createPage's
  // pageId short-circuit) so a replay (resume/crash-replay of the SAME run) of a publish node reuses the same container
  // instead of duplicating it. ABOVE the cap check so a replay never spuriously trips
  // "cap reached" while re-publishing an existing document.
  //
  // ADR 0838 D1 — but ONLY a row this (tenant, org) owns. `documents:doc` is keyed
  // by id alone, so a row held by another tenant or org used to read as "absent"
  // here and the blind put below replaced it: the victim's document moved into
  // the caller's tenant. Live through the demo seeder's shared ids.
  // ADR 0848 D1 — the shared rule (`host/ownedInsert.ts`), lifted out of this file so
  // the email stores could not keep their own private (and missing) copy. `build` holds
  // the cap and validation, so an owned replay converges ABOVE them, exactly as before.
  const documentId = input.documentId ?? `doc:${randomUUID()}`;
  const { row } = await insertOwnedOrConflict(docs, documentId, (d) => d.tenantId === input.tenantId && d.orgId === input.orgId, async () => {
    const total = (await docs.list()).filter((d) => d.tenantId === input.tenantId && d.orgId === input.orgId).length;
    if (total >= MAX.docsPerOrg) throw new OpenwopError('validation_error', `Document cap reached (${MAX.docsPerOrg}).`, 400, {});
    const owner = await resolveOwnerSubject(input.ownerSubject, input.tenantId, input.orgId);
    const now = new Date().toISOString();
    const doc: DocumentRecord = {
      documentId,
      tenantId: input.tenantId,
      orgId: input.orgId,
      ...(owner ? { ownerSubject: owner } : {}),
      kind: asKind(input.kind),
      format: input.format === undefined ? 'markdown' : asFormat(input.format),
      title: boundString(input.title, 'title', MAX.title),
      status: 'draft',
      ...(input.templateId ? { templateId: input.templateId } : {}),
      provenance: input.provenance,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return doc;
  });
  return row;
}


export async function updateDocument(
  tenantId: string, orgId: string, documentId: string, actor: string,
  patch: { title?: unknown; status?: unknown; ownerSubject?: unknown; promotedCanvasId?: unknown; approvedVersionId?: unknown },
): Promise<DocumentRecord | null> {
  const existing = await getDocument(tenantId, orgId, documentId);
  if (!existing) return null;
  // Validate the inputs that need I/O ONCE, outside the CAS loop.
  const title = patch.title !== undefined ? boundString(patch.title, 'title', MAX.title) : undefined;
  const owner = patch.ownerSubject !== undefined && patch.ownerSubject !== null
    ? await resolveOwnerSubject(patch.ownerSubject, tenantId, orgId)
    : undefined;
  let target: DocStatus | undefined;
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !(DOC_STATUSES as readonly string[]).includes(patch.status)) {
      throw new OpenwopError('validation_error', `\`status\` MUST be one of: ${DOC_STATUSES.join(', ')}.`, 400, { field: 'status' });
    }
    target = patch.status as DocStatus;
  }
  // ADR 0838 A1 — approve what you SAW: the client names the version on screen.
  let approvedVersionId: string | undefined;
  if (patch.approvedVersionId !== undefined) {
    if (!target || !(SHAREABLE_STATUSES as readonly string[]).includes(target)) {
      throw new OpenwopError('validation_error', '`approvedVersionId` is only valid when approving (status approved or final).', 400, { field: 'approvedVersionId' });
    }
    const vid = boundString(patch.approvedVersionId, 'approvedVersionId', MAX.title);
    if (!(await getVersion(tenantId, orgId, documentId, vid))) {
      throw new OpenwopError('validation_error', '`approvedVersionId` is not a version of this document.', 400, { field: 'approvedVersionId' });
    }
    approvedVersionId = vid;
  }
  let promotedCanvasId: string | undefined;
  if (patch.promotedCanvasId !== undefined) promotedCanvasId = boundString(patch.promotedCanvasId, 'promotedCanvasId', MAX.title);

  // ADR 0838 A2 — a CAS over the fresh row: the transition check and the pin are
  // evaluated against the row that is swapped, so a version saved while this
  // request ran is never rolled back or pinned unseen.
  return mutateDocument(documentId, (fresh) => {
    if (fresh.tenantId !== tenantId || fresh.orgId !== orgId) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId });
    const next: DocumentRecord = { ...fresh, updatedBy: actor, updatedAt: new Date().toISOString() };
    if (title !== undefined) next.title = title;
    if (target) {
      if (!STATUS_TRANSITIONS[fresh.status].includes(target)) {
        throw new OpenwopError('conflict', `Invalid status transition: ${fresh.status} → ${target}.`, 409, { from: fresh.status, to: target });
      }
      next.status = target;
      if ((SHAREABLE_STATUSES as readonly string[]).includes(target)) {
        // ADR 0838 D2 — approving pins the text that publishes.
        // No version named: a document that is ALREADY published keeps its pin
        // (approved → final must not publish text nobody approved); a first
        // approval pins the current version (API clients from before ADR 0838).
        const alreadyPublished = (SHAREABLE_STATUSES as readonly string[]).includes(fresh.status) ? fresh.approvedVersionId : undefined;
        const pin = approvedVersionId ?? alreadyPublished ?? fresh.currentVersionId;
        if (!pin) throw new OpenwopError('conflict', 'A document needs content before it can be approved.', 409, { reason: 'no_content' });
        next.approvedVersionId = pin;
      } else {
        delete next.approvedVersionId;
      }
    }
    if (patch.ownerSubject !== undefined) {
      if (owner) next.ownerSubject = owner; else delete next.ownerSubject;
    }
    if (promotedCanvasId !== undefined) {
      // Set once (ADR 0350 Phase 3). Idempotent: a repeat with the SAME id is a
      // no-op; a DIFFERENT id after one is set is rejected (a doc promotes to ONE
      // canvas — no silent re-point that would strand the first).
      if (fresh.promotedCanvasId && fresh.promotedCanvasId !== promotedCanvasId) {
        throw new OpenwopError('conflict', 'Document is already promoted to a rich document.', 409, { promotedCanvasId: fresh.promotedCanvasId });
      }
      next.promotedCanvasId = promotedCanvasId;
    }
    return next;
  });
}

export async function deleteDocument(tenantId: string, orgId: string, documentId: string): Promise<boolean> {
  const existing = await getDocument(tenantId, orgId, documentId);
  if (!existing) return false;
  // `DOCWF-2` — assert the retention hold before anything is destroyed.
  //
  // This cascades versions (whose `content` is declared PII), the rendered assets below, and
  // the public share links, and it ran under a legal hold without a word. It is the same shape
  // the projects cascade had one iteration ago, and — like that one — it is structurally
  // INVISIBLE to `destructive-lane-census.test.ts`, whose population derives from
  // storage-level deletes plus seam runners; a `DurableCollection.delete()` is neither. The
  // census row lands with this change.
  //
  // Inline, not behind a helper: the census scans a lane's OWN text for the consult.
  await assertNoRetentionHold(tenantId);
  // `DOCWF-3` — the RENDERED BYTES, before the versions that point at them.
  //
  // This cascade already purges the public share links, with a comment saying the point is that
  // no row may "report in use externally". The rendered PDF/DOCX is the actual CONTENT, it is
  // served by a PUBLIC token-authed route (`GET /assets/:token` — the token IS the capability),
  // and nothing deleted it. So a document could be deleted, its links purged, and its rendered
  // bytes keep serving forever to anyone holding the URL — the opposite of what the person was
  // told, and incomplete against this function's own stated intent rather than merely a missing
  // nicety.
  //
  // Best-effort and ordered FIRST so a media failure cannot strand a version row that is the
  // only remaining way to find the token.
  const renderedTokens = new Set<string>();
  const priorVersions = await listVersions(tenantId, orgId, documentId);
  for (const v of priorVersions) {
    if (v.renderedMediaToken) renderedTokens.add(v.renderedMediaToken);
    for (const entry of Object.values(v.renderedTokens ?? {})) {
      if (entry?.token) renderedTokens.add(entry.token);
    }
  }
  if (renderedTokens.size > 0) {
    try {
      const { listAssets, deleteAsset } = await import('../media/mediaService.js');
      const orgAssets = await listAssets(tenantId, orgId);
      for (const a of orgAssets) {
        if (a.serveToken && renderedTokens.has(a.serveToken)) await deleteAsset(tenantId, orgId, a.assetId);
      }
    } catch (err) {
      log.error('document_delete_rendered_asset_purge_failed', {
        tenantId, orgId, documentId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Cascade versions FIRST so a mid-failure leaves no orphan reachable from a
  // surviving parent (partial-failure fails closed).
  for (const v of priorVersions) await versions.delete(v.versionId);
  // WF-SHARE-4 — cascade the public share links that referenced this document.
  // Dynamic import: sharing imports THIS module for its resolver, so a static
  // edge back would cycle (the crm/signService precedent). Best-effort — a
  // cascade failure must not fail the delete, and the link would 404 anyway;
  // what it must not do is leave a row that reports "in use externally".
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    await purgeLinksForResource(tenantId, 'document', documentId);
  } catch { /* best-effort cascade — the link resolves 404 regardless */ }
  return docs.delete(documentId);
}

// ─── versions (immutable, deterministic id, idempotent) ──────────────────────

export async function listVersions(tenantId: string, orgId: string, documentId: string): Promise<DocumentVersion[]> {
  const all = await versions.listByPrefix(`${documentId}:`);
  return all
    .filter((v) => v.tenantId === tenantId && v.orgId === orgId && v.documentId === documentId)
    .sort((a, b) => b.version - a.version);
}

export async function getVersion(tenantId: string, orgId: string, documentId: string, versionId: string): Promise<DocumentVersion | null> {
  const v = await versions.get(versionId);
  return v && v.tenantId === tenantId && v.orgId === orgId && v.documentId === documentId ? v : null;
}

/**
 * Append an immutable version. `versionId` is deterministic (`${documentId}:${n}`)
 * and the insert uses compare-and-swap (insert-only-if-absent), so concurrent
 * writers either advance the counter safely or collide (retry) — no lost/dup rows
 * (the ADR 0053 TOCTOU rule). An `idempotencyKey` short-circuits a retried run to
 * the version it already produced.
 */
export async function addVersion(
  tenantId: string, orgId: string, documentId: string,
  input: { content: unknown; renderedMediaToken?: string; producedBy: Provenance['producedBy']; idempotencyKey?: string; baseVersionId?: string | null },
): Promise<DocumentVersion> {
  const doc = await getDocument(tenantId, orgId, documentId);
  if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId });
  const content = boundString(input.content, 'content', MAX.contentBytes);
  const idem = input.idempotencyKey ? boundString(input.idempotencyKey, 'idempotencyKey', MAX.idempotencyKey) : undefined;

  const existing = await listVersions(tenantId, orgId, documentId);
  if (idem) {
    const prior = existing.find((v) => v.idempotencyKey === idem);
    if (prior) return prior; // idempotent replay/retry
  }
  if (existing.length >= MAX.versionsPerDoc) throw new OpenwopError('validation_error', `Version cap reached (${MAX.versionsPerDoc}).`, 400, {});

  // ADR 0838 D5 — a CHECKED edit: the caller names the version it read. It must
  // be the current one, and the new version takes the very next number with NO
  // retry, so a concurrent save makes this one fail instead of landing on top of
  // text the caller never saw (the slot is insert-only-if-absent).
  let checkedNum: number | undefined;
  // ADR 0913 D5 (Book AI P11) — `baseVersionId: null` is the checked FIRST save:
  // "I saw no version". It is the version-1 case of the same check, so two first
  // saves from two tabs cannot both land (the slot write below is insert-only).
  if (input.baseVersionId === null) {
    if (existing.length > 0) throw staleBase(documentId, existing[0]?.versionId ?? doc.currentVersionId);
    checkedNum = 1;
  } else if (input.baseVersionId !== undefined) {
    const base = boundString(input.baseVersionId, 'baseVersionId', MAX.title);
    // The base must be the NEWEST version that exists, not merely the pointer:
    // a version row is inserted before the pointer moves, so a crash (or a lost
    // pointer race from before ADR 0838) can leave the pointer one behind. A
    // check against the lagging pointer would refuse every checked save forever
    // (grade-code H2). Heal the pointer forward so a reload shows the real latest.
    const newest = existing[0];
    if (newest && newest.versionId !== doc.currentVersionId) await advancePointer(tenantId, orgId, documentId, newest);
    if (!newest || newest.versionId !== base) throw staleBase(documentId, newest?.versionId ?? doc.currentVersionId);
    checkedNum = newest.version + 1;
  }

  // Monotonic next version with CAS retry against concurrent writers.
  let nextNum = checkedNum ?? (existing[0]?.version ?? 0) + 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const versionId = `${documentId}:${nextNum}`;
    const version: DocumentVersion = {
      versionId,
      documentId,
      tenantId,
      orgId,
      version: nextNum,
      content,
      ...(input.renderedMediaToken ? { renderedMediaToken: input.renderedMediaToken } : {}),
      producedBy: input.producedBy,
      ...(idem ? { idempotencyKey: idem } : {}),
      createdAt: new Date().toISOString(),
    };
    const inserted = await versions.compareAndSwap(null, version); // insert-only-if-absent
    if (!inserted) {
      if (checkedNum !== undefined) throw staleBase(documentId, (await docs.get(documentId))?.currentVersionId);
      nextNum += 1; continue; // someone took this id; advance + retry
    }
    // Point the document at the new current version (derived pointer). ADR 0838
    // A2: a CAS over the fresh row that only moves FORWARD, so a slower writer of
    // a lower version can never pull the pointer back, and a concurrent PATCH's
    // fields survive.
    await advancePointer(tenantId, orgId, documentId, version);
    // ADR 0853 D7 — announce the new text (fail-soft; never fails the save).
    const previous = existing.find((v) => v.version < version.version);
    await notifyDocumentVersionAdded({
      tenantId, orgId, documentId, title: doc.title, kind: doc.kind,
      ...(doc.ownerSubject ? { ownerSubject: doc.ownerSubject } : {}),
      version: version.version, content, previousContent: previous?.content ?? '', producedBy: input.producedBy,
    });
    return version;
  }
  throw new OpenwopError('conflict', 'Could not allocate a version id (too many concurrent writes).', 409, { documentId });
}

/** ADR 0838 A2 — move the current-version pointer FORWARD to `version` (never
 *  back), merged into the fresh row. A slower writer of a lower version cannot
 *  pull it back, and a concurrent PATCH's fields survive. */
async function advancePointer(tenantId: string, orgId: string, documentId: string, version: Pick<DocumentVersion, 'versionId' | 'version' | 'createdAt' | 'producedBy'>): Promise<void> {
  await mutateDocument(documentId, async (fresh) => {
    if (fresh.tenantId !== tenantId || fresh.orgId !== orgId) return null;
    const currentNum = fresh.currentVersionId ? (await getVersion(tenantId, orgId, documentId, fresh.currentVersionId))?.version ?? 0 : 0;
    if (currentNum >= version.version) return null;
    const next: DocumentRecord = { ...fresh, currentVersionId: version.versionId, updatedAt: version.createdAt, updatedBy: version.producedBy.id };
    // ADR 0838 D2 — a row approved BEFORE the pin existed publishes its current
    // version. Pin that version now, in the same swap that moves past it, so the
    // text that was public stays public and this new one does not.
    if ((SHAREABLE_STATUSES as readonly string[]).includes(fresh.status) && !fresh.approvedVersionId && fresh.currentVersionId) {
      next.approvedVersionId = fresh.currentVersionId;
    }
    return next;
  });
}

function staleBase(documentId: string, currentVersionId: string | undefined): OpenwopError {
  return new OpenwopError('conflict', 'This document has a newer version than the one the edit was based on. Read it again, then re-apply the edit.', 409, {
    reason: 'stale_base', documentId, ...(currentVersionId ? { currentVersionId } : {}),
  });
}

/**
 * ADR 0838 D3 — THE document read predicate. A document carrying a project/user
 * `ownerSubject` is membership-scoped (ADR 0610 D3′): the org gate is not
 * enough. Ask the ONE `subjectAccess` seam whether `subject` may READ the owner.
 * `null` there ⇒ not membership-scoped (no resolver for that kind) ⇒ the org gate
 * stands. Every exit that hands out a document's content calls this: the HTTP
 * doors, the chat tools, the run surface, the artifact projection and the share
 * mint. `subject` undefined ⇒ refused when the document is membership-scoped.
 */
export async function canReadDocument(tenantId: string, doc: Pick<DocumentRecord, 'ownerSubject'>, subject: string | undefined): Promise<boolean> {
  if (!doc.ownerSubject) return true;
  const level = await resolveSubjectAccess(tenantId, doc.ownerSubject, subject);
  return level === null || levelSatisfies(level, 'read');
}

// ─── templates (bind the prompt machinery; own the output contract) ──────────

export async function getTemplate(tenantId: string, orgId: string, templateId: string): Promise<DocumentTemplate | null> {
  const t = await templates.get(templateId);
  return t && t.tenantId === tenantId && t.orgId === orgId ? t : null;
}

export async function listTemplates(tenantId: string, orgId: string, kind?: string): Promise<DocumentTemplate[]> {
  const all = await templates.list();
  return all
    .filter((t) => t.tenantId === tenantId && t.orgId === orgId)
    .filter((t) => (kind ? t.kind === kind : true))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function sanitizeParams(input: unknown): TemplateParams {
  const raw = (input ?? {}) as Record<string, unknown>;
  const required = Array.isArray(raw.required) ? raw.required.filter((r): r is string => typeof r === 'string') : [];
  const props = (raw.properties ?? {}) as Record<string, unknown>;
  const properties: TemplateParams['properties'] = {};
  for (const [k, v] of Object.entries(props)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(k)) throw new OpenwopError('validation_error', `parameters.properties key \`${k}\` MUST match [a-zA-Z0-9_]{1,64}.`, 400, {});
    const spec = (v ?? {}) as Record<string, unknown>;
    properties[k] = {
      ...(typeof spec.type === 'string' ? { type: spec.type } : {}),
      ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
    };
  }
  for (const r of required) if (!(r in properties)) throw new OpenwopError('validation_error', `parameters.required references unknown property \`${r}\`.`, 400, {});
  return { required, properties };
}

export async function createTemplate(input: {
  tenantId: string; orgId: string; name: unknown; kind: unknown; outputFormat?: unknown;
  promptBody: unknown; promptRef?: unknown; parameters?: unknown; outputSchema?: unknown;
  artifactTypeId?: unknown; createdBy: string;
  /** WF-DOC-9 — seed-catalog origin. Supplied ONLY by `instantiateSeedTemplate`
   *  (the HTTP route never forwards it), so a client cannot forge provenance. */
  catalogId?: string;
}): Promise<DocumentTemplate> {
  const total = (await templates.list()).filter((t) => t.tenantId === input.tenantId && t.orgId === input.orgId).length;
  if (total >= MAX.templatesPerOrg) throw new OpenwopError('validation_error', `Template cap reached (${MAX.templatesPerOrg}).`, 400, {});
  const promptRef = input.promptRef;
  if (promptRef !== undefined && (typeof promptRef !== 'string' || !/^prompt:[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/.test(promptRef))) {
    throw new OpenwopError('validation_error', '`promptRef` MUST be a `prompt:templateId[@version]` ref.', 400, { field: 'promptRef' });
  }
  // ADR 0055: a bound artifactTypeId MUST be a registered host artifact type (no
  // more opaque tags). Omit it for a free-form (untyped) template.
  if (typeof input.artifactTypeId === 'string' && input.artifactTypeId.trim() && !isRegisteredArtifactType(input.artifactTypeId)) {
    throw new OpenwopError('validation_error', `Unknown artifactTypeId \`${input.artifactTypeId}\` — not a registered host artifact type.`, 400, { field: 'artifactTypeId' });
  }
  const now = new Date().toISOString();
  const tmpl: DocumentTemplate = {
    templateId: `tmpl:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    name: boundString(input.name, 'name', MAX.title),
    kind: asKind(input.kind),
    outputFormat: input.outputFormat === undefined ? 'markdown' : asFormat(input.outputFormat),
    promptBody: boundString(input.promptBody, 'promptBody', MAX.promptBodyBytes),
    ...(typeof promptRef === 'string' ? { promptRef } : {}),
    parameters: sanitizeParams(input.parameters),
    ...(input.outputSchema && typeof input.outputSchema === 'object' ? { outputSchema: input.outputSchema as Record<string, unknown> } : {}),
    ...(typeof input.artifactTypeId === 'string' && input.artifactTypeId.trim() ? { artifactTypeId: input.artifactTypeId } : {}),
    ...(typeof input.catalogId === 'string' && input.catalogId.trim() ? { catalogId: input.catalogId } : {}),
    version: 1,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await templates.put(tmpl);
  return tmpl;
}

/** Instantiate a built-in starter (seedTemplates) into the org as an editable
 *  `documents:template` row. The catalog is read-only; this is a copy. */
export async function instantiateSeedTemplate(tenantId: string, orgId: string, catalogId: string, createdBy: string): Promise<DocumentTemplate> {
  const seed = getSeedTemplate(catalogId);
  if (!seed) throw new OpenwopError('not_found', 'Starter template not found.', 404, { catalogId });
  // Bind the starter to its matching host artifact type when one exists (ADR 0055),
  // so generation from it emits a typed, validated artifact.
  const artifactTypeId = isRegisteredArtifactType(`doc.${seed.kind}`) ? `doc.${seed.kind}` : undefined;
  return createTemplate({
    tenantId, orgId, name: seed.name, kind: seed.kind, outputFormat: seed.outputFormat,
    promptBody: seed.promptBody, parameters: seed.parameters,
    ...(artifactTypeId ? { artifactTypeId } : {}),
    // WF-DOC-9 — stamp the origin at copy time (unbackfillable afterwards).
    catalogId,
    createdBy,
  });
}

export async function updateTemplate(
  tenantId: string, orgId: string, templateId: string,
  patch: { name?: unknown; promptBody?: unknown; parameters?: unknown; outputSchema?: unknown; artifactTypeId?: unknown },
): Promise<DocumentTemplate | null> {
  const existing = await getTemplate(tenantId, orgId, templateId);
  if (!existing) return null;
  const next: DocumentTemplate = { ...existing, version: existing.version + 1, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = boundString(patch.name, 'name', MAX.title);
  if (patch.promptBody !== undefined) next.promptBody = boundString(patch.promptBody, 'promptBody', MAX.promptBodyBytes);
  if (patch.parameters !== undefined) next.parameters = sanitizeParams(patch.parameters);
  if (patch.outputSchema !== undefined) {
    if (patch.outputSchema === null) delete next.outputSchema;
    else if (typeof patch.outputSchema === 'object') next.outputSchema = patch.outputSchema as Record<string, unknown>;
  }
  if (patch.artifactTypeId !== undefined) {
    if (typeof patch.artifactTypeId === 'string' && patch.artifactTypeId.trim()) {
      // DOCT-6 — the SAME registered-type check `createTemplate` enforces. An
      // edit could previously bind an unregistered type, and generation from
      // the template then silently skipped typed-artifact validation.
      if (!isRegisteredArtifactType(patch.artifactTypeId)) {
        throw new OpenwopError('validation_error', `Unknown artifactTypeId \`${patch.artifactTypeId}\` — not a registered host artifact type.`, 400, { field: 'artifactTypeId' });
      }
      next.artifactTypeId = patch.artifactTypeId;
    } else delete next.artifactTypeId;
  }
  await templates.put(next);
  return next;
}

export async function deleteTemplate(tenantId: string, orgId: string, templateId: string): Promise<boolean> {
  const existing = await getTemplate(tenantId, orgId, templateId);
  if (!existing) return false;
  return templates.delete(templateId);
}

export interface AssembleResult {
  augmentedPrompt: string;
  outputFormat: DocFormat;
  outputSchema?: Record<string, unknown>;
  artifactTypeId?: string;
  templateId: string;
  templateVersion: number;
}

/**
 * Validate `params` against the template's `parameters` schema and render the
 * generator body with `{{name}}` substitution → an `augmentedPrompt` ready to feed
 * an agent / `ctx.callAI`. NO LLM call here (run-scoped — the KB `:rag` analogue).
 */
export async function assemble(tenantId: string, orgId: string, templateId: string, params: Record<string, unknown>): Promise<AssembleResult> {
  const tmpl = await getTemplate(tenantId, orgId, templateId);
  if (!tmpl) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId });
  const safe = (params ?? {}) as Record<string, unknown>;
  for (const r of tmpl.parameters.required) {
    const v = safe[r];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      throw new OpenwopError('validation_error', `Required parameter \`${r}\` is missing.`, 400, { field: r });
    }
  }
  const augmentedPrompt = tmpl.promptBody.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = safe[key];
    return v === undefined || v === null ? '' : String(v);
  });
  return {
    augmentedPrompt,
    outputFormat: tmpl.outputFormat,
    ...(tmpl.outputSchema ? { outputSchema: tmpl.outputSchema } : {}),
    ...(tmpl.artifactTypeId ? { artifactTypeId: tmpl.artifactTypeId } : {}),
    templateId: tmpl.templateId,
    templateVersion: tmpl.version,
  };
}

/** Public-share projection of a document (approved/final only — gated by caller). */
export async function publicDocumentView(tenantId: string, orgId: string, documentId: string): Promise<Record<string, unknown> | null> {
  const doc = await getDocument(tenantId, orgId, documentId);
  if (!doc || !(SHAREABLE_STATUSES as readonly string[]).includes(doc.status)) return null;
  // ADR 0838 D2 — the APPROVED version, never whatever was written since.
  const publishedId = publicVersionIdOf(doc);
  const current = publishedId ? await getVersion(tenantId, orgId, documentId, publishedId) : null;
  // DOCTPL-2 — public attribution. The content shown IS the current version,
  // so its producer wins; the document's provenance is the fallback. KIND
  // only — internal agent/user/run ids never reach the public surface. An
  // agent can mint an SOW, a human can approve it, and it can publish to the
  // open internet: the page must be able to say a model wrote it.
  const producer = current?.producedBy ?? doc.provenance?.producedBy;
  return {
    kind: 'document',
    documentId: doc.documentId,
    title: doc.title,
    documentKind: doc.kind,
    format: doc.format,
    status: doc.status,
    content: current?.content ?? '',
    ...(current ? { version: current.version } : {}),
    ...(current?.renderedMediaToken ? { renderedMediaToken: current.renderedMediaToken } : {}),
    ...(producer?.kind ? { producedByKind: producer.kind } : {}),
    updatedAt: doc.updatedAt,
  };
}

/** ADR 0838 D2 — the version a shareable document publishes: its pin, or (for a
 *  row approved before the pin existed, which `addVersion` pins on its next
 *  write) its current version. `undefined` when it publishes nothing. */
export function publicVersionIdOf(doc: Pick<DocumentRecord, 'status' | 'approvedVersionId' | 'currentVersionId'>): string | undefined {
  if (!(SHAREABLE_STATUSES as readonly string[]).includes(doc.status)) return undefined;
  return doc.approvedVersionId ?? doc.currentVersionId;
}

export type RenderFormat = 'pdf' | 'slides' | 'sheet' | 'docx' | 'epub' | 'odt' | 'latex';
export const RENDER_FORMATS: readonly RenderFormat[] = ['pdf', 'slides', 'sheet', 'docx', 'epub', 'odt', 'latex'];
export interface RenderResult { versionId: string; format: RenderFormat; renderedMediaToken: string; url: string; sizeBytes: number; }

const RENDER_SPEC: Record<RenderFormat, { contentType: string; ext: string }> = {
  pdf: { contentType: 'application/pdf', ext: 'pdf' },
  slides: { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  sheet: { contentType: 'text/csv', ext: 'csv' },
  docx: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  epub: { contentType: 'application/epub+zip', ext: 'epub' },
  odt: { contentType: 'application/vnd.oasis.opendocument.text', ext: 'odt' },
  latex: { contentType: 'application/x-tex', ext: 'tex' },
};

/** ADR 0400 — editable exports are REGENERABLE from the immutable version, so
 *  they ride short-TTL scratch Media (the slidesExport posture) instead of the
 *  durable library path; kvAgeOut (ADR 0380) sweeps them with no new purger. */
const EXPORT_FORMATS: ReadonlySet<RenderFormat> = new Set(['docx', 'epub', 'odt', 'latex']);
const EXPORT_TTL_SECONDS = 60 * 60; // 1 hour — the slides/code-export posture
const MAX_EXPORT_BYTES = 25 * 1024 * 1024;

/** Markdown image src → embeddable bytes, tenant-checked (ADR 0400): only a
 *  HOST asset serve URL/token resolves; external URLs return null (the walker
 *  degrades them to linked text — never fetched, the SSRF posture). */
function exportImageResolver(tenantId: string): ExportImageResolver {
  return async (src) => {
    const m = src.match(/\/assets\/([A-Za-z0-9_-]{1,512})\/?(?:[?#]|$)/);
    if (!m) return null;
    const entry = await resolveMediaAsset(m[1] ?? '');
    if (!entry || entry.tenantId !== tenantId) return null;
    const data = Buffer.from(entry.contentBase64, 'base64');
    const dims = probeImageDims(data);
    if (!dims) return null;
    return { data, kind: dims.kind, width: dims.width, height: dims.height };
  };
}

/**
 * Render the document's CURRENT version (ADR 0057). Deterministic + provider-free,
 * so callable synchronously (route) AND from the run-scoped node via the surface.
 * Stores the bytes as a Media asset (RFC 0055). For `pdf` (the canonical shareable
 * representation) it stamps the version's `renderedMediaToken`; `slides`/`sheet`
 * return their URL without overwriting that pointer.
 */
export async function renderDocument(tenantId: string, orgId: string, documentId: string, actor: string, format: RenderFormat = 'pdf'): Promise<RenderResult> {
  const doc = await getDocument(tenantId, orgId, documentId);
  if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId });
  const version = doc.currentVersionId ? await getVersion(tenantId, orgId, documentId, doc.currentVersionId) : null;
  if (!version) throw new OpenwopError('validation_error', 'Document has no content to render.', 400, { documentId });

  // WF-DOC-4 — idempotent render→store for the DURABLE formats (pdf/slides/
  // sheet). The version is immutable and every renderer deterministic (the
  // JSZip pin), so a re-render/replay of the SAME version converges on the
  // SAME stored asset + serve token. Before this, every invocation minted a
  // fresh library asset and (for pdf) REWROTE the version's
  // renderedMediaToken, invalidating previously shared PDF links. Scratch
  // exports (docx/epub/odt/latex) stay per-call by design: TTL'd
  // download-and-go, no durable growth.
  if (!EXPORT_FORMATS.has(format)) {
    const prior = version.renderedTokens?.[format];
    if (prior) {
      return { versionId: version.versionId, format, renderedMediaToken: prior.token, url: mediaStorage.serveUrl(prior.token), sizeBytes: prior.sizeBytes };
    }
  }

  const bytes = format === 'slides'
    ? await renderMarkdownToPptx(version.content, { title: doc.title })
    : format === 'sheet'
      ? renderMarkdownToCsv(version.content)
      : format === 'docx'
        ? await renderMarkdownToDocx(version.content, { title: doc.title, resolveImage: exportImageResolver(tenantId) })
        : format === 'epub'
          ? await renderMarkdownToEpub(version.content, { title: doc.title, identifier: `urn:openwop:doc:${version.versionId}`, modifiedAt: version.createdAt, resolveImage: exportImageResolver(tenantId) })
          : format === 'odt'
            ? await renderMarkdownToOdt(version.content, { title: doc.title, resolveImage: exportImageResolver(tenantId) })
            : format === 'latex'
              ? Buffer.from(await renderMarkdownToLatex(version.content, { title: doc.title }), 'utf8')
              : await renderMarkdownToPdf(version.content, { title: doc.title });
  const spec = RENDER_SPEC[format];
  if (bytes.byteLength > MAX_EXPORT_BYTES) {
    throw new OpenwopError('validation_error', `Export exceeds the ${Math.floor(MAX_EXPORT_BYTES / (1024 * 1024))} MiB cap.`, 413, { format });
  }
  // ADR 0400 — editable exports are scratch-TTL, download-and-go; PDF (the
  // canonical shareable rep) stays a durable library asset with the stamped
  // version pointer, exactly as before.
  if (EXPORT_FORMATS.has(format)) {
    const scratch = await storeMediaAsset(tenantId, { contentBase64: bytes.toString('base64'), contentType: spec.contentType, ttlSeconds: EXPORT_TTL_SECONDS });
    return { versionId: version.versionId, format, renderedMediaToken: scratch.token, url: mediaStorage.serveUrl(scratch.token), sizeBytes: scratch.bytes };
  }
  // WF-DOC-4 — a LEGACY pdf stamp (pre-`renderedTokens` rows): honor the
  // existing token rather than rewrite it. The bytes above are deterministic
  // for this immutable version, so only the size needed re-deriving — no new
  // asset, no restamp, and the previously shared link stays valid.
  if (format === 'pdf' && version.renderedMediaToken && !version.renderedTokens?.pdf) {
    return { versionId: version.versionId, format, renderedMediaToken: version.renderedMediaToken, url: mediaStorage.serveUrl(version.renderedMediaToken), sizeBytes: bytes.byteLength };
  }
  const stored = await mediaStorage.put(tenantId, { contentBase64: bytes.toString('base64'), contentType: spec.contentType });
  const safeName = (doc.title.replace(/[^\w .-]/g, '_').slice(0, 120) || 'document');
  await createAsset({
    tenantId, orgId, name: `${safeName}.${spec.ext}`, contentType: spec.contentType,
    sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: actor,
  });
  // Review F6 — the stamp write is a real cross-instance CAS, not a blind put.
  // Two concurrent renders of DIFFERENT formats each read `version` above,
  // then each wrote its own merged `renderedTokens` map — a classic lost
  // update: the last writer erased the other format's stamp, so the NEXT
  // render of the erased format minted a duplicate asset (and, for pdf,
  // restamped the token this whole block exists to keep stable). Merge from
  // the FRESH row inside a compareAndSwap retry loop so both stamps survive.
  for (let attempt = 0; ; attempt++) {
    const fresh = await getVersion(tenantId, orgId, documentId, version.versionId);
    if (!fresh) break; // version row gone (concurrent purge) — nothing to stamp
    const next = {
      ...fresh,
      ...(format === 'pdf' ? { renderedMediaToken: stored.serveToken } : {}),
      renderedTokens: { ...(fresh.renderedTokens ?? {}), [format]: { token: stored.serveToken, sizeBytes: stored.sizeBytes } },
    };
    if (await versions.compareAndSwap(fresh, next)) break;
    if (attempt >= 7) throw new OpenwopError('conflict', 'Could not stamp the rendered asset (too many concurrent writes).', 409, { documentId, format });
  }
  return { versionId: version.versionId, format, renderedMediaToken: stored.serveToken, url: mediaStorage.serveUrl(stored.serveToken), sizeBytes: stored.sizeBytes };
}

const CANVAS_KIND: Record<string, string> = { 'canvas.brief': 'epic-brief', 'canvas.design': 'doc', 'canvas.launch': 'doc' };

function canvasContentToMarkdown(state: unknown): string {
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const o = state as Record<string, unknown>;
    for (const f of ['content', 'markdown', 'text', 'body']) {
      if (typeof o[f] === 'string' && (o[f] as string).trim()) return o[f] as string;
    }
  }
  if (typeof state === 'string') return state;
  return '```json\n' + JSON.stringify(state, null, 2) + '\n```';
}

/**
 * Materialize a canvas into a durable Document (ADR 0056). One-way: canvas/launch-
 * studio → documents (the single owner of stored business docs, ADR 0053). Idempotent
 * per (tenant,org,canvas): a first call creates the document + mapping; later calls add
 * a new version. A `kind:'project'` canvas owner carries through when it resolves to
 * this org. Reads the canvas via the host seam (feature→host import is allowed).
 */
export async function materializeCanvasToDocument(tenantId: string, orgId: string, canvasId: string, actor: string, access?: ToggleSubject): Promise<{ documentId: string; versionId: string; created: boolean }> {
  // The shared predicate: only a caller who may READ the canvas may copy its
  // content into an org document (uniform 404 on refusal).
  const canvas = await getCanvasForCaller(tenantId, canvasId, { subject: actor });
  if (!canvas) throw new OpenwopError('not_found', 'Canvas not found.', 404, { canvasId });
  // ADR 0820 G5 — copying a canvas into a Document is a READ of that canvas, so
  // it needs the canvas TYPE's feature (toggle + plan), not only `documents`:
  // otherwise a documents-only plan materializes any slides/cad/app-builder
  // canvas. Toggle off is the uniform 404 the type's own routes give; a plan
  // refusal is the route lane's 403.
  const typeAccess = await resolveCanvasTypeAccess(canvas.canvasTypeId, access ?? { tenantId, userId: actor });
  if (!typeAccess.allowed) {
    if (typeAccess.blockedBy === 'plan') {
      throw new OpenwopError('forbidden', 'Your plan does not include this canvas type.', 403, { feature: typeAccess.toggleId, reason: 'plan' });
    }
    throw new OpenwopError('not_found', 'Canvas not found.', 404, { canvasId });
  }
  const content = canvasContentToMarkdown(canvas.state);
  const idempotencyKey = `canvas:${canvasId}:${canvas.version}`;
  const key = `${tenantId}:${orgId}:${canvasId}`;

  // Reuse the mapped document ONLY if it still exists — a user may have deleted it,
  // in which case we must re-create rather than 404 on addVersion (stale-mapping fix).
  const existing = await canvasMap.get(key);
  if (existing && (await getDocument(tenantId, orgId, existing.documentId))) {
    const v = await addVersion(tenantId, orgId, existing.documentId, { content, producedBy: { kind: 'user', id: actor }, idempotencyKey });
    return { documentId: existing.documentId, versionId: v.versionId, created: false };
  }

  let ownerSubject: Subject | undefined;
  if (canvas.projectId && (await resolveSubjectOrg(tenantId, { kind: 'project', id: canvas.projectId })) === orgId) {
    ownerSubject = { kind: 'project', id: canvas.projectId };
  }
  const doc = await createDocument({
    tenantId, orgId, title: canvas.name ?? `From ${canvas.canvasTypeId}`,
    kind: CANVAS_KIND[canvas.canvasTypeId] ?? 'doc', format: 'markdown',
    ...(ownerSubject ? { ownerSubject } : {}),
    provenance: { producedBy: { kind: 'user', id: actor } }, createdBy: actor,
  });
  await canvasMap.put({ key, tenantId, documentId: doc.documentId });
  const v = await addVersion(tenantId, orgId, doc.documentId, { content, producedBy: { kind: 'user', id: actor }, idempotencyKey });
  return { documentId: doc.documentId, versionId: v.versionId, created: true };
}

/** Test-only: clear all three stores. */
export async function __resetDocumentsStore(): Promise<void> {
  await docs.__clear();
  await versions.__clear();
  await templates.__clear();
}
