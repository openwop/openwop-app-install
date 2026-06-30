/**
 * Chat artifact workbench projection (ADR 0069) — a type-neutral, READ-ONLY view
 * over durable artifacts so chat can preview / revise / diff / approve / audit
 * work without a second artifact store.
 *
 * Ownership is delegated to the existing owner: a `doc.*` artifact IS a Documents
 * record + immutable DocumentVersions (ADR 0053). This module maps those into a
 * stable `ArtifactProjection`/`ArtifactRevisionProjection` DTO and computes diffs
 * over two immutable revisions. It is NOT a `DurableCollection`; it creates no
 * rows. Media- and run-event-sourced artifacts slot in behind the same
 * `source` discriminant later (the `artifactId` prefix keeps the namespace open).
 *
 * Authorization mirrors the Documents feature: org is resolved FROM the record
 * (never trusted from the request) and checked with `resolveEffectiveAccess`
 * (`workspace:read`); a non-visible artifact returns null → the route maps it to
 * 404, never 403 (no existence leak).
 *
 * Non-normative; reached under `/v1/host/openwop-app/artifacts/*`. No new wire.
 *
 * @see docs/adr/0069-chat-artifact-workbench.md
 */

import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { resolveEffectiveAccess } from './accessControlService.js';
import { isRegisteredArtifactType } from './artifactTypes.js';
import { diffText, diffJson, type TextDiff, type JsonDiff } from './textDiff.js';
import {
  getDocumentByIdForTenant,
  listVersions,
  getVersion,
  type DocumentRecord,
  type DocumentVersion,
  type Provenance,
} from '../features/documents/documentsService.js';
import { getAssetByIdForTenant, viewAsset, listAssetsForTenant, type MediaAsset } from '../features/media/mediaService.js';
import { listDocumentsForTenant } from '../features/documents/documentsService.js';
import { getRunArtifact, listRunArtifactsForTenant, type RunArtifactRecord } from './runArtifactStore.js';
import type { Subject } from './subject.js';

export type ArtifactSource = 'document' | 'media' | 'run-event';

export interface ArtifactProjection {
  artifactId: string;
  tenantId: string;
  orgId: string;
  ownerSubject?: Subject;
  artifactTypeId?: string;
  source: ArtifactSource;
  sourceId: string;
  title: string;
  kind: string;
  format: string;
  status: string;
  latestRevisionId?: string;
  createdBy: { kind: 'user' | 'agent' | 'run'; id: string };
  createdAt: string;
  provenance: {
    runId?: string;
    nodeId?: string;
    templateId?: string;
    producedBy?: Provenance['producedBy'];
  };
}

export interface ArtifactRevisionProjection {
  revisionId: string;
  artifactId: string;
  version: number;
  summary?: string;
  /** The full revision body — included only on a SINGLE-revision fetch (the
   *  preview/raw tabs), omitted from the list to keep the timeline lightweight. */
  content?: string;
  createdBy: Provenance['producedBy'];
  createdAt: string;
}

/** The artifactId for a Media-backed artifact (ADR 0069). */
export function mediaArtifactId(assetId: string): string {
  return `media:${assetId}`;
}

/** A media artifact is an immutable single blob — one synthetic revision. */
function mediaRevisionId(assetId: string): string {
  return `${assetId}:1`;
}

/** Coarse artifact kind from a MIME type, for display. */
function mediaKind(contentType: string): string {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf') return 'pdf';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
}

export function mediaToArtifact(asset: MediaAsset): ArtifactProjection {
  return {
    artifactId: mediaArtifactId(asset.assetId),
    tenantId: asset.tenantId,
    orgId: asset.orgId,
    source: 'media',
    sourceId: asset.assetId,
    title: asset.name,
    kind: mediaKind(asset.contentType),
    format: asset.contentType,
    status: 'final', // media bytes are immutable once uploaded
    latestRevisionId: mediaRevisionId(asset.assetId),
    createdBy: { kind: 'user', id: asset.uploadedBy },
    createdAt: asset.createdAt,
    provenance: {},
  };
}

/** The single revision of a media artifact. `content` (the serve URL) is included
 *  only on the single-revision fetch, so the workbench can render the bytes. */
function mediaToRevision(asset: MediaAsset, includeContent = false): ArtifactRevisionProjection {
  return {
    revisionId: mediaRevisionId(asset.assetId),
    artifactId: mediaArtifactId(asset.assetId),
    version: 1,
    summary: asset.name,
    ...(includeContent ? { content: viewAsset(asset).serveUrl } : {}),
    createdBy: { kind: 'user', id: asset.uploadedBy },
    createdAt: asset.createdAt,
  };
}

/** The artifactId for a Documents-backed artifact. The explicit `document:`
 *  source prefix discriminates the owner (split on the FIRST colon) and keeps the
 *  namespace open for `media:`/`run-event:` later. */
export function documentArtifactId(documentId: string): string {
  return `document:${documentId}`;
}

/** Parse an artifactId into its source + the owner's id. */
export function parseArtifactId(artifactId: string): { source: string; sourceId: string } | null {
  const sep = artifactId.indexOf(':');
  if (sep <= 0) return null;
  return { source: artifactId.slice(0, sep), sourceId: artifactId.slice(sep + 1) };
}

// ── mappers ──────────────────────────────────────────────────────────────

function firstLine(content: string): string | undefined {
  const line = content.split('\n').find((l) => l.trim().length > 0);
  return line ? (line.length > 120 ? `${line.slice(0, 120)}…` : line) : undefined;
}

export function documentToArtifact(doc: DocumentRecord): ArtifactProjection {
  // The seeded host artifact types are `doc.<kind>` (doc.sow, doc.prd, …); only
  // claim one when it is actually registered, so the field is honest.
  const candidateType = `doc.${doc.kind}`;
  return {
    artifactId: documentArtifactId(doc.documentId),
    tenantId: doc.tenantId,
    orgId: doc.orgId,
    ...(doc.ownerSubject ? { ownerSubject: doc.ownerSubject } : {}),
    ...(isRegisteredArtifactType(candidateType) ? { artifactTypeId: candidateType } : {}),
    source: 'document',
    sourceId: doc.documentId,
    title: doc.title,
    kind: doc.kind,
    format: doc.format,
    status: doc.status,
    ...(doc.currentVersionId ? { latestRevisionId: doc.currentVersionId } : {}),
    createdBy: doc.provenance.producedBy,
    createdAt: doc.createdAt,
    provenance: {
      ...(doc.provenance.runId ? { runId: doc.provenance.runId } : {}),
      ...(doc.provenance.nodeId ? { nodeId: doc.provenance.nodeId } : {}),
      ...(doc.provenance.templateId ? { templateId: doc.provenance.templateId } : {}),
      producedBy: doc.provenance.producedBy,
    },
  };
}

export function versionToRevision(artifactId: string, v: DocumentVersion, includeContent = false): ArtifactRevisionProjection {
  return {
    revisionId: v.versionId,
    artifactId,
    version: v.version,
    ...(firstLine(v.content) ? { summary: firstLine(v.content) } : {}),
    ...(includeContent ? { content: v.content } : {}),
    createdBy: v.producedBy,
    createdAt: v.createdAt,
  };
}

// ── run-event source (ADR 0083) — the run-output producer ────────────────

/** A run-artifact is an immutable single output — one synthetic revision. */
function runArtifactRevisionId(artifactKey: string): string {
  return `${artifactKey}:1`;
}

export function runArtifactToArtifact(row: RunArtifactRecord): ArtifactProjection {
  return {
    artifactId: `run-event:${row.artifactKey}`,
    tenantId: row.tenantId,
    orgId: row.orgId,
    // ADR 0055/0128 — surface the node-declared artifact type so the workbench
    // renderer (which dispatches on it, e.g. interactive.*) can pick it up.
    ...(row.artifactTypeId && isRegisteredArtifactType(row.artifactTypeId) ? { artifactTypeId: row.artifactTypeId } : {}),
    source: 'run-event',
    sourceId: row.artifactKey,
    title: row.title,
    kind: row.kind,
    format: row.format,
    status: row.status,
    latestRevisionId: runArtifactRevisionId(row.artifactKey),
    createdBy: { kind: 'run', id: row.createdBy },
    createdAt: row.createdAt,
    provenance: { runId: row.runId, nodeId: row.nodeId, producedBy: { kind: 'run', id: row.runId } },
  };
}

function runArtifactToRevision(row: RunArtifactRecord, includeContent = false): ArtifactRevisionProjection {
  return {
    revisionId: runArtifactRevisionId(row.artifactKey),
    artifactId: `run-event:${row.artifactKey}`,
    version: 1,
    ...(firstLine(row.content) ? { summary: firstLine(row.content) } : {}),
    ...(includeContent ? { content: row.content } : {}),
    createdBy: { kind: 'run', id: row.createdBy },
    createdAt: row.createdAt,
  };
}

/** Resolve a run-event artifact, enforcing org access FROM the stored row. */
async function resolveRunArtifact(tenantId: string, subject: string | undefined, artifactId: string): Promise<RunArtifactRecord | null> {
  const parsed = parseArtifactId(artifactId);
  if (!parsed || parsed.source !== 'run-event') return null;
  const row = await getRunArtifact(parsed.sourceId);
  if (!row || row.tenantId !== tenantId) return null;
  // A link/bookkeeping row (ADR 0083 amendment) is NOT a run-event artifact — its canonical
  // artifact is the linked media:/document: owner; never project it as run-event.
  if (row.linkedArtifactId) return null;
  const access = await resolveEffectiveAccess(tenantId, { ...(subject ? { subject } : {}), orgId: row.orgId });
  return access.scopes.includes('workspace:read') ? row : null;
}

// ── authorization + composition ─────────────────────────────────────────

/** Resolve a Documents-backed artifact for the caller, enforcing org access FROM
 *  the record. Returns the DocumentRecord when visible, else null (→ 404). */
async function authorizeDocument(tenantId: string, subject: string | undefined, documentId: string): Promise<DocumentRecord | null> {
  const doc = await getDocumentByIdForTenant(tenantId, documentId);
  if (!doc) return null;
  const access = await resolveEffectiveAccess(tenantId, { ...(subject ? { subject } : {}), orgId: doc.orgId });
  return access.scopes.includes('workspace:read') ? doc : null;
}

/** Resolve `(tenantId, subject, artifactId)` to its DocumentRecord, or null when
 *  it is not a document artifact / not found / not visible. */
async function resolveDocumentArtifact(tenantId: string, subject: string | undefined, artifactId: string): Promise<DocumentRecord | null> {
  const parsed = parseArtifactId(artifactId);
  if (!parsed || parsed.source !== 'document') return null;
  return authorizeDocument(tenantId, subject, parsed.sourceId);
}

/** Resolve a Media-backed artifact, enforcing org access FROM the asset record
 *  (mirrors the document path). The third source, `run-event:<…>`, is now LIVE
 *  (ADR 0083 — `resolveRunArtifact` below) and is populated by the run-artifact
 *  producer (`host/runArtifactStore.ts`); host-internal, still no normative
 *  `artifact.created` wire event. */
async function resolveMediaArtifact(tenantId: string, subject: string | undefined, artifactId: string): Promise<MediaAsset | null> {
  const parsed = parseArtifactId(artifactId);
  if (!parsed || parsed.source !== 'media') return null;
  const asset = await getAssetByIdForTenant(tenantId, parsed.sourceId);
  if (!asset) return null;
  const access = await resolveEffectiveAccess(tenantId, { ...(subject ? { subject } : {}), orgId: asset.orgId });
  return access.scopes.includes('workspace:read') ? asset : null;
}

export async function getArtifact(tenantId: string, subject: string | undefined, artifactId: string): Promise<ArtifactProjection | null> {
  const doc = await resolveDocumentArtifact(tenantId, subject, artifactId);
  if (doc) return documentToArtifact(doc);
  const asset = await resolveMediaArtifact(tenantId, subject, artifactId);
  if (asset) return mediaToArtifact(asset);
  const run = await resolveRunArtifact(tenantId, subject, artifactId);
  return run ? runArtifactToArtifact(run) : null;
}

export async function listArtifactRevisions(tenantId: string, subject: string | undefined, artifactId: string): Promise<ArtifactRevisionProjection[] | null> {
  const doc = await resolveDocumentArtifact(tenantId, subject, artifactId);
  if (doc) {
    const versions = await listVersions(tenantId, doc.orgId, doc.documentId);
    return versions.map((v) => versionToRevision(artifactId, v));
  }
  const asset = await resolveMediaArtifact(tenantId, subject, artifactId);
  if (asset) return [mediaToRevision(asset)]; // a media blob is a single immutable revision
  const run = await resolveRunArtifact(tenantId, subject, artifactId);
  return run ? [runArtifactToRevision(run)] : null; // a run output is a single immutable revision
}

export async function getArtifactRevision(tenantId: string, subject: string | undefined, artifactId: string, revisionId: string): Promise<ArtifactRevisionProjection | null> {
  const doc = await resolveDocumentArtifact(tenantId, subject, artifactId);
  if (doc) {
    const v = await getVersion(tenantId, doc.orgId, doc.documentId, revisionId);
    return v ? versionToRevision(artifactId, v, true) : null;
  }
  const asset = await resolveMediaArtifact(tenantId, subject, artifactId);
  if (asset) return revisionId === mediaRevisionId(asset.assetId) ? mediaToRevision(asset, true) : null;
  const run = await resolveRunArtifact(tenantId, subject, artifactId);
  if (!run) return null;
  return revisionId === runArtifactRevisionId(run.artifactKey) ? runArtifactToRevision(run, true) : null;
}

/**
 * The Library (ADR 0083 P3) — every artifact the caller can see in the tenant, across
 * sources (documents + media + run-event), newest first.
 *
 * Authorization is PER-ORG, resolved FROM each record's org (documents + media live in
 * sub-orgs where the caller's membership is — NOT necessarily the workspace-root org, so a
 * single root-org check would wrongly return an empty Library; review MED-2 fix). Resolved
 * ONCE per distinct org (batched), never per artifact, to avoid the N+1 fan-out
 * (CLAUDE.md rate-limit gotcha). Run-event artifacts are org === tenantId by construction.
 */
export async function listArtifacts(tenantId: string, subject: string | undefined): Promise<ArtifactProjection[]> {
  const [docs, assets, runs] = await Promise.all([
    listDocumentsForTenant(tenantId),
    listAssetsForTenant(tenantId),
    listRunArtifactsForTenant(tenantId),
  ]);
  // Batch: resolve workspace:read ONCE per distinct org across all candidate records.
  const orgIds = [...new Set<string>([...docs.map((d) => d.orgId), ...assets.map((a) => a.orgId), ...runs.map((r) => r.orgId)])];
  const canRead = new Map<string, boolean>();
  // ART-3 — fail-CLOSED + partial-result: `allSettled` (not `all`) so one org's access
  // resolver erroring deny-filters only that org's artifacts instead of 500-ing the whole
  // Library (an unset `canRead` entry is already a deny via the `.get(...)` filters below).
  // A rejection is LOGGED — fail-closed must not be SILENT (it under-populates the Library).
  const settled = await Promise.allSettled(orgIds.map(async (orgId) => {
    const access = await resolveEffectiveAccess(tenantId, { ...(subject ? { subject } : {}), orgId });
    canRead.set(orgId, access.scopes.includes('workspace:read'));
  }));
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      log.warn('artifact_library_org_access_failed', {
        tenantId, orgId: orgIds[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });
  const projections: ArtifactProjection[] = [
    ...docs.filter((d) => canRead.get(d.orgId)).map(documentToArtifact),
    ...assets.filter((a) => canRead.get(a.orgId)).map(mediaToArtifact),
    ...runs.filter((r) => canRead.get(r.orgId)).map(runArtifactToArtifact),
  ];
  // Stable newest-first ordering, tie-broken by id, so the ART-1 keyset cursor is well-defined.
  return projections.sort((a, b) => {
    const ca = artifactCursor(a), cb = artifactCursor(b);
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
}

const log = createLogger('host.artifactProjection');
const DEFAULT_LIBRARY_LIMIT = 100;
const MAX_LIBRARY_LIMIT = 500;
// ART-4 — combined revision-size ceiling for the O(n·m) line/structural diff. Set BELOW the
// max possible combined size (2 × the 1 MB per-version document cap) so the guard is actually
// reachable for a pair of near-max documents — at 2 MB it was dead code (combined can't exceed it).
const MAX_DIFF_CHARS = 1_500_000;
/** Keyset cursor key: `${createdAt}\0${artifactId}` — matches the desc sort in `listArtifacts`. */
function artifactCursor(a: ArtifactProjection): string {
  return `${a.createdAt} ${a.artifactId}`;
}

export interface ListArtifactsPage { artifacts: ArtifactProjection[]; nextCursor?: string }

/**
 * ART-1 — the Library route's BOUNDED view: a keyset page over `listArtifacts`. Caps the wire
 * payload + FE render at `limit` (default 100, max 500) with a `nextCursor` for "load more".
 * NOTE: the underlying store scan is still O(n) (the accepted reference-host posture, FEAT-1);
 * this bounds the PAYLOAD, which is the user-facing risk — full keyset-at-the-store is the
 * id-scheme migration tracked elsewhere.
 */
export async function listArtifactsPage(
  tenantId: string,
  subject: string | undefined,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ListArtifactsPage> {
  const all = await listArtifacts(tenantId, subject);
  const limit = Math.max(1, Math.min(MAX_LIBRARY_LIMIT, Math.trunc(opts.limit ?? DEFAULT_LIBRARY_LIMIT)));
  const start = opts.cursor ? all.findIndex((a) => artifactCursor(a) < opts.cursor!) : 0;
  const from = start < 0 ? all.length : start; // cursor past the end ⇒ empty page
  const page = all.slice(from, from + limit);
  const more = from + page.length < all.length;
  return { artifacts: page, ...(more && page.length > 0 ? { nextCursor: artifactCursor(page[page.length - 1]!) } : {}) };
}

export interface ArtifactDiffResult {
  artifactId: string;
  from: string;
  to: string;
  diff: TextDiff | JsonDiff;
}

/**
 * Diff two IMMUTABLE revisions of an artifact. Both ids MUST be concrete
 * versionIds (never "latest" / a mutable pointer) — an absent revision is a 422,
 * not a silent fallback, so an audit of a diff always pins two fixed revisions.
 * JSON content is structurally diffed; everything else is line-diffed.
 */
export async function diffArtifact(
  tenantId: string,
  subject: string | undefined,
  artifactId: string,
  fromId: string,
  toId: string,
): Promise<ArtifactDiffResult | null> {
  const doc = await resolveDocumentArtifact(tenantId, subject, artifactId);
  if (!doc) {
    // Media + run-event artifacts are single immutable revisions — nothing to diff.
    const asset = await resolveMediaArtifact(tenantId, subject, artifactId);
    if (asset) throw new OpenwopError('validation_error', 'media artifacts have a single revision; there is nothing to diff.', 422, { artifactId });
    const run = await resolveRunArtifact(tenantId, subject, artifactId);
    if (run) throw new OpenwopError('validation_error', 'run-output artifacts have a single revision; there is nothing to diff.', 422, { artifactId });
    return null;
  }
  if (!fromId || !toId) {
    throw new OpenwopError('validation_error', 'diff requires concrete from + to revision ids (no "latest").', 422, { artifactId });
  }
  const [a, b] = await Promise.all([
    getVersion(tenantId, doc.orgId, doc.documentId, fromId),
    getVersion(tenantId, doc.orgId, doc.documentId, toId),
  ]);
  if (!a || !b) {
    throw new OpenwopError('validation_error', 'one or both revisions do not exist for this artifact.', 422, { artifactId, from: fromId, to: toId });
  }
  // ART-4 — the line/structural diff is O(n·m); guard a pathological large-document diff with
  // a 422 rather than spiking CPU/memory. (Run-event/media inline content is 1 MB-capped
  // upstream, so this only bites an unusually large Documents-backed artifact.)
  if (a.content.length + b.content.length > MAX_DIFF_CHARS) {
    throw new OpenwopError('validation_error', `artifact revisions are too large to diff (> ${MAX_DIFF_CHARS} chars combined).`, 422, { artifactId, chars: a.content.length + b.content.length });
  }
  const diff = jsonOrNull(a.content) !== null && jsonOrNull(b.content) !== null
    ? diffJson(jsonOrNull(a.content), jsonOrNull(b.content))
    : diffText(a.content, b.content);
  return { artifactId, from: fromId, to: toId, diff };
}

/** Parse content as JSON, or null when it isn't JSON (so we pick the line-diff). */
function jsonOrNull(content: string): unknown {
  const t = content.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}
