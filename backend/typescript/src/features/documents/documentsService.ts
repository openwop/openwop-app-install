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

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { resolveSubjectOrg } from '../../host/subjectOrgScope.js';
import type { Subject, SubjectKind } from '../../host/subject.js';
import { getUser } from '../users/usersService.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { getSeedTemplate } from './seedTemplates.js';
import { renderMarkdownToPdf, renderMarkdownToPptx, renderMarkdownToCsv } from './render.js';
import * as mediaStorage from '../media/mediaStorage.js';
import { createAsset } from '../media/mediaService.js';
import { isRegisteredArtifactType } from '../../host/artifactTypes.js';
import { getCanvasForTenant } from '../../host/canvasSurface.js';

// ─── vocabulary ──────────────────────────────────────────────────────────────

export type DocFormat = 'markdown' | 'pdf' | 'slides' | 'diagram' | 'sheet' | 'doc';
export const DOC_FORMATS: readonly DocFormat[] = ['markdown', 'pdf', 'slides', 'diagram', 'sheet', 'doc'];

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
  templateId?: string;
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
  /** OPTIONAL opaque artifact-type tag (RFC 0071/0075 NOT implemented here). */
  artifactTypeId?: string;
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
const versions = new DurableCollection<DocumentVersion>('documents:version', (v) => v.versionId);
const templates = new DurableCollection<DocumentTemplate>('documents:template', (t) => t.templateId);
// ADR 0056 — deterministic (tenant,org,canvas) → documentId mapping so re-materializing
// a canvas updates its document (a new version) rather than spawning duplicates.
const canvasMap = new DurableCollection<{ key: string; documentId: string }>('documents:canvasmap', (m) => m.key);

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
    const a = await getRosterEntry(subject.id);
    if (!a || a.tenantId !== tenantId) {
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
  // pageId short-circuit) so a replay/fork of a publish node reuses the same container
  // instead of duplicating it. ABOVE the cap check so a replay never spuriously trips
  // "cap reached" while re-publishing an existing document.
  if (input.documentId) {
    const prior = await getDocument(input.tenantId, input.orgId, input.documentId);
    if (prior) return prior;
  }
  const total = (await docs.list()).filter((d) => d.tenantId === input.tenantId && d.orgId === input.orgId).length;
  if (total >= MAX.docsPerOrg) throw new OpenwopError('validation_error', `Document cap reached (${MAX.docsPerOrg}).`, 400, {});
  const owner = await resolveOwnerSubject(input.ownerSubject, input.tenantId, input.orgId);
  const now = new Date().toISOString();
  const doc: DocumentRecord = {
    documentId: input.documentId ?? `doc:${randomUUID()}`,
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
  await docs.put(doc);
  return doc;
}

export async function updateDocument(
  tenantId: string, orgId: string, documentId: string, actor: string,
  patch: { title?: unknown; status?: unknown; ownerSubject?: unknown },
): Promise<DocumentRecord | null> {
  const existing = await getDocument(tenantId, orgId, documentId);
  if (!existing) return null;
  const next: DocumentRecord = { ...existing, updatedBy: actor, updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) next.title = boundString(patch.title, 'title', MAX.title);
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !(DOC_STATUSES as readonly string[]).includes(patch.status)) {
      throw new OpenwopError('validation_error', `\`status\` MUST be one of: ${DOC_STATUSES.join(', ')}.`, 400, { field: 'status' });
    }
    const target = patch.status as DocStatus;
    if (!STATUS_TRANSITIONS[existing.status].includes(target)) {
      throw new OpenwopError('conflict', `Invalid status transition: ${existing.status} → ${target}.`, 409, { from: existing.status, to: target });
    }
    next.status = target;
  }
  if (patch.ownerSubject !== undefined) {
    const owner = patch.ownerSubject === null ? undefined : await resolveOwnerSubject(patch.ownerSubject, tenantId, orgId);
    if (owner) next.ownerSubject = owner; else delete next.ownerSubject;
  }
  await docs.put(next);
  return next;
}

export async function deleteDocument(tenantId: string, orgId: string, documentId: string): Promise<boolean> {
  const existing = await getDocument(tenantId, orgId, documentId);
  if (!existing) return false;
  // Cascade versions FIRST so a mid-failure leaves no orphan reachable from a
  // surviving parent (partial-failure fails closed).
  for (const v of await listVersions(tenantId, orgId, documentId)) await versions.delete(v.versionId);
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
  input: { content: unknown; renderedMediaToken?: string; producedBy: Provenance['producedBy']; idempotencyKey?: string },
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

  // Monotonic next version with CAS retry against concurrent writers.
  let nextNum = (existing[0]?.version ?? 0) + 1;
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
    if (!inserted) { nextNum += 1; continue; } // someone took this id; advance + retry
    // Point the document at the new current version (derived pointer).
    const fresh = await docs.get(documentId);
    if (fresh) await docs.put({ ...fresh, currentVersionId: versionId, updatedAt: version.createdAt, updatedBy: input.producedBy.id });
    return version;
  }
  throw new OpenwopError('conflict', 'Could not allocate a version id (too many concurrent writes).', 409, { documentId });
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
    ...(artifactTypeId ? { artifactTypeId } : {}), createdBy,
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
    if (typeof patch.artifactTypeId === 'string' && patch.artifactTypeId.trim()) next.artifactTypeId = patch.artifactTypeId;
    else delete next.artifactTypeId;
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
  const current = doc.currentVersionId ? await getVersion(tenantId, orgId, documentId, doc.currentVersionId) : null;
  return {
    kind: 'document',
    documentId: doc.documentId,
    title: doc.title,
    documentKind: doc.kind,
    format: doc.format,
    status: doc.status,
    content: current?.content ?? '',
    ...(current?.renderedMediaToken ? { renderedMediaToken: current.renderedMediaToken } : {}),
    updatedAt: doc.updatedAt,
  };
}

export type RenderFormat = 'pdf' | 'slides' | 'sheet';
export const RENDER_FORMATS: readonly RenderFormat[] = ['pdf', 'slides', 'sheet'];
export interface RenderResult { versionId: string; format: RenderFormat; renderedMediaToken: string; url: string; sizeBytes: number; }

const RENDER_SPEC: Record<RenderFormat, { contentType: string; ext: string }> = {
  pdf: { contentType: 'application/pdf', ext: 'pdf' },
  slides: { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  sheet: { contentType: 'text/csv', ext: 'csv' },
};

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

  const bytes = format === 'slides'
    ? await renderMarkdownToPptx(version.content, { title: doc.title })
    : format === 'sheet'
      ? renderMarkdownToCsv(version.content)
      : await renderMarkdownToPdf(version.content, { title: doc.title });
  const spec = RENDER_SPEC[format];
  const stored = await mediaStorage.put(tenantId, { contentBase64: bytes.toString('base64'), contentType: spec.contentType });
  const safeName = (doc.title.replace(/[^\w .-]/g, '_').slice(0, 120) || 'document');
  await createAsset({
    tenantId, orgId, name: `${safeName}.${spec.ext}`, contentType: spec.contentType,
    sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: actor,
  });
  if (format === 'pdf') await versions.put({ ...version, renderedMediaToken: stored.serveToken });
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
export async function materializeCanvasToDocument(tenantId: string, orgId: string, canvasId: string, actor: string): Promise<{ documentId: string; versionId: string; created: boolean }> {
  const canvas = await getCanvasForTenant(tenantId, canvasId);
  if (!canvas) throw new OpenwopError('not_found', 'Canvas not found.', 404, { canvasId });
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
  await canvasMap.put({ key, documentId: doc.documentId });
  const v = await addVersion(tenantId, orgId, doc.documentId, { content, producedBy: { kind: 'user', id: actor }, idempotencyKey });
  return { documentId: doc.documentId, versionId: v.versionId, created: true };
}

/** Test-only: clear all three stores. */
export async function __resetDocumentsStore(): Promise<void> {
  await docs.__clear();
  await versions.__clear();
  await templates.__clear();
}
