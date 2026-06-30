/**
 * Run-output artifact store (ADR 0083, +reference-resolution amendment) — the PRODUCER
 * for the chat artifact workbench (ADR 0069) + the `artifactProjection` `run-event` source.
 *
 * The executor persists a node's output here (at a HITL suspend, and at run completion).
 * The KEY design rule (the amendment): `run-event` persistence is a FALLBACK for outputs
 * with NO other owner. A node output is classified, in priority order:
 *   1. DOCUMENT reference (`{documentId}`) → LINK the existing `document:` artifact (the
 *      Documents feature already owns it) — no inline blob, no duplicate.
 *   2. INLINE BINARY (`{contentBase64}` / `{audioBase64}` / `{videoBase64}` / `images[]`)
 *      → MINT a `media:` asset from the bytes → LINK it (so image/audio/video preview as
 *      real bytes via the existing media source, not a JSON blob).
 *   3. SERVE reference (`{renderedMediaToken}` / a `/assets/` URL) → a run-event artifact
 *      whose content is a click-to-open Markdown link (the assetId isn't recoverable from a
 *      bare serve token).
 *   4. INLINE CONTENT (text/markdown/json) → a run-event artifact, size-capped (~1 MB).
 *
 * Host-internal (a `DurableCollection`); NO normative `artifact.created` run event is emitted.
 * Replay-safe: keyed on the DETERMINISTIC `${runId}:${nodeId}` and insert-only via
 * compare-and-swap (first-write-wins) — so retries/re-dispatch never duplicate or re-mint
 * (including the non-deterministic media mint: a bookkeeping row records the minted
 * `media:`/`document:` id, and a re-execution returns it without re-minting). Content is
 * secret-scrubbed before storage.
 *
 * @see docs/adr/0083-run-output-artifacts-and-preview.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { put as putMediaBytes } from '../features/media/mediaStorage.js';
import { createAsset, assertOrgCapacity, deleteAsset } from '../features/media/mediaService.js';
import { getDocumentByIdForTenant } from '../features/documents/documentsService.js';
import { isRegisteredArtifactType, validateArtifact } from './artifactTypes.js';

const log = createLogger('host.runArtifact');

/** Inline run-event content cap (mirrors the Documents version cap). Larger text is
 *  truncated with a marker; binary is routed to media (capped at the org media quota). */
const MAX_INLINE_BYTES = 1_000_000;

/** Artifact-id source prefixes (ART-5) — the single source for the `<source>:<id>`
 *  artifact-id scheme so the producer (here) and any reader agree on one set of
 *  literals. A `run-event:` id is an inline run-output artifact; `media:` / `document:`
 *  ids LINK an existing media asset / Document owner. */
const ARTIFACT_PREFIX = { runEvent: 'run-event:', media: 'media:', document: 'document:' } as const;

export interface RunArtifactRecord {
  /** Deterministic primary key `${runId}:${nodeId}` — replay-safe. */
  artifactKey: string;
  tenantId: string;
  /** Workspace-root org convention (= run.tenantId; RunRecord has no orgId). */
  orgId: string;
  runId: string;
  nodeId: string;
  role: 'deliverable' | 'gate-preview';
  title: string;
  /** Coarse kind for display/filtering: text | markdown | data | file. */
  kind: string;
  format: string;
  status: string;
  /** The serialized output body (single immutable revision). Empty for a link row. */
  content: string;
  /** ADR 0055/0128 — the host artifact type a node declared via the typed
   *  `{ artifact: { artifactTypeId, payload } }` output envelope (e.g.
   *  `interactive.mermaid`, `code.execution-result`). Surfaced to the workbench,
   *  whose renderer dispatches on it. Set only when the type is host-registered. */
  artifactTypeId?: string;
  createdBy: string; // the run id (createdBy.kind === 'run')
  createdAt: string;
  /** When set, this row is BOOKKEEPING ONLY (idempotency): the output was resolved to an
   *  existing owner — a `media:<assetId>` or `document:<documentId>` artifact — so the
   *  canonical artifact is that owner, not a run-event. Excluded from the Library list and
   *  from run-event projection (the owner represents it). */
  linkedArtifactId?: string;
  linkedRevisionId?: string;
}

const runArtifacts = new DurableCollection<RunArtifactRecord>('runartifact', (a) => a.artifactKey);

export function runArtifactKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

/** Collapse a lone `output`/`input` port to the bare value for classification + preview. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 1 && (keys[0] === 'output' || keys[0] === 'input')) return rec[keys[0]!];
  }
  return value;
}

const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*]\s|\d+\.\s|```|>\s)/;

/** Derive { content, kind, format, title } from an inline node output. */
export function deriveArtifact(output: unknown, nodeId: string): { content: string; kind: string; format: string; title: string } {
  const value = unwrap(output);
  let content: string;
  let kind: string;
  let format: string;
  if (typeof value === 'string') {
    content = value;
    const t = value.trim();
    if (t.startsWith('{') || t.startsWith('[')) { kind = 'data'; format = 'application/json'; }
    else if (MARKDOWN_HINT.test(value)) { kind = 'markdown'; format = 'text/markdown'; }
    else { kind = 'text'; format = 'text/plain'; }
  } else {
    content = JSON.stringify(value ?? null, null, 2);
    kind = 'data';
    format = 'application/json';
  }
  const firstLine = content.split('\n').find((l) => l.trim().length > 0)?.trim();
  const title = firstLine ? (firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine) : `${nodeId} output`;
  return { content, kind, format, title };
}

/** ADR 0055/0128 — a node may declare a typed INLINE artifact via an
 *  `{ artifact: { artifactTypeId, payload, title? } }` output envelope. When the
 *  declared type is host-registered, the PAYLOAD is the artifact's content (a
 *  string verbatim — e.g. mermaid source for `interactive.mermaid`; an object is
 *  JSON-serialized). Returns null when there is no honored inline typed envelope,
 *  so the caller falls through to the generic inline-content path.
 *
 *  The envelope's `contentTrust` (if present) is advisory only and intentionally
 *  NOT persisted: the workbench renders `interactive.*` unconditionally inside the
 *  origin-isolated / no-egress sandbox, so these artifacts are untrusted by
 *  construction regardless of the flag.
 *
 *  Document-BACKED envelopes (those carrying a `documentId`, e.g. the documents
 *  `assemble` node) are excluded — they are represented by their Document via the
 *  doc-ref link path, not a duplicate run-event blob (so this is a no-op for them). */
export function detectTypedArtifact(value: unknown, nodeId: string): { artifactTypeId: string; content: string; kind: string; format: string; title: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const env = (value as { artifact?: unknown }).artifact;
  if (!env || typeof env !== 'object') return null;
  const e = env as { artifactTypeId?: unknown; payload?: unknown; documentId?: unknown; title?: unknown };
  if (typeof e.documentId === 'string') return null; // document-backed → linked via the doc path
  if (e.payload === undefined || e.payload === null) return null; // nothing to render → fall through
  if (typeof e.artifactTypeId !== 'string' || !isRegisteredArtifactType(e.artifactTypeId)) return null;
  // IART-3: validate the payload against the registered schema — a malformed typed payload
  // (e.g. a chart missing `chartType`, a non-string where raw text is required) falls through
  // to the generic content path rather than minting a typed artifact that can't render.
  if (!validateArtifact(e.artifactTypeId, e.payload).valid) return null;
  const derived = deriveArtifact(e.payload, nodeId);
  return { artifactTypeId: e.artifactTypeId, ...derived, ...(typeof e.title === 'string' && e.title.trim() ? { title: e.title.trim() } : {}) };
}

// ── reference detection (resolve-before-serialize) ────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A `documentId` anywhere the document-producing nodes put it. */
function detectDocumentRef(v: unknown): string | null {
  const r = asRecord(v);
  if (!r) return null;
  if (typeof r.documentId === 'string') return r.documentId;
  const doc = asRecord(r.document);
  if (doc && typeof doc.documentId === 'string') return doc.documentId;
  return null;
}

// MED-3 (review hardening): the base64/serve detectors are field-name heuristics over
// arbitrary node output. Require a value that actually LOOKS like base64 (length + charset)
// before minting a media asset, so a stray short field (`contentBase64: "n/a"`) can't consume
// org quota. A real encoded asset is hundreds+ of chars; 64 is a safe floor.
const BASE64_CHARSET = /^[A-Za-z0-9+/=\s]+$/;
function looksLikeBase64(s: string): boolean {
  if (s.length < 64 || !BASE64_CHARSET.test(s.slice(0, 256))) return false;
  // ART-6 — also require that the head actually DECODES to non-trivial bytes, so a 64+ char
  // all-padding/whitespace string (charset-valid but zero-byte) can't mint an empty asset.
  return Buffer.from(s.slice(0, 128), 'base64').length >= 8;
}

interface MediaBytes { contentBase64: string; contentType: string; name: string }

/** Inline base64 bytes (image/audio/video/file generators). Returns ALL assets — for a
 *  multi-image generator (`images: [{contentBase64}, …]`) that's every image (ADR 0083 #3),
 *  not just the first; the single-field cases return one. */
function detectBase64All(v: unknown): MediaBytes[] {
  const r = asRecord(v);
  if (!r) return [];
  const ct = (fallback: string): string => (typeof r.contentType === 'string' ? r.contentType : fallback);
  if (typeof r.contentBase64 === 'string' && looksLikeBase64(r.contentBase64)) return [{ contentBase64: r.contentBase64, contentType: ct('application/octet-stream'), name: 'output' }];
  if (typeof r.audioBase64 === 'string' && looksLikeBase64(r.audioBase64)) return [{ contentBase64: r.audioBase64, contentType: ct('audio/mpeg'), name: 'audio' }];
  if (typeof r.videoBase64 === 'string' && looksLikeBase64(r.videoBase64)) return [{ contentBase64: r.videoBase64, contentType: ct('video/mp4'), name: 'video' }];
  if (Array.isArray(r.images)) {
    const out: MediaBytes[] = [];
    for (let i = 0; i < r.images.length; i++) {
      const im = asRecord(r.images[i]);
      if (im && typeof im.contentBase64 === 'string' && looksLikeBase64(im.contentBase64)) {
        out.push({ contentBase64: im.contentBase64, contentType: typeof im.contentType === 'string' ? im.contentType : 'image/png', name: `image-${i + 1}` });
      }
    }
    return out;
  }
  return [];
}

/** A serve token / `/assets/` URL — bytes already stored, but assetId not recoverable. */
function detectServeRef(v: unknown): { serveUrl: string; name: string } | null {
  const r = asRecord(v);
  if (!r) return null;
  if (typeof r.renderedMediaToken === 'string') return { serveUrl: `/v1/host/openwop-app/assets/${r.renderedMediaToken}`, name: 'Rendered file' };
  const img = asRecord(r.image);
  if (img && typeof img.url === 'string') return { serveUrl: img.url, name: typeof img.alt === 'string' && img.alt ? img.alt : 'Image' };
  if (typeof r.url === 'string' && r.url.includes('/assets/')) return { serveUrl: r.url, name: 'File' };
  return null;
}

/** URL-based image array (ADR 0115 — the image-generate node's actual output:
 *  `images: [{ url, mimeType }]`, where the bytes are ALREADY stored as host media assets
 *  by `callImageGenerator` and referenced by serve url). The single-ref `detectServeRef`
 *  misses the array, so without this every generated image would project as a JSON blob
 *  rather than a previewable media artifact. Returns ALL (the base64-array sibling). */
function detectServeRefAll(v: unknown): { serveUrl: string; name: string }[] {
  const r = asRecord(v);
  if (!r || !Array.isArray(r.images)) return [];
  const out: { serveUrl: string; name: string }[] = [];
  for (let i = 0; i < r.images.length; i++) {
    const im = asRecord(r.images[i]);
    if (im && typeof im.url === 'string' && im.url) {
      out.push({ serveUrl: im.url, name: `image-${i + 1}` });
    }
  }
  return out;
}

function extOf(contentType: string): string {
  const sub = contentType.split('/')[1] ?? 'bin';
  return sub.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
}

export interface PersistRunArtifactInput {
  tenantId: string;
  runId: string;
  nodeId: string;
  role: 'deliverable' | 'gate-preview';
  output: unknown;
  now: string;
}

type PersistResult = { artifactId: string; revisionId: string } | null;

/** The PersistResult for a stored row (link → its owner; else the run-event id). */
function resultFor(row: RunArtifactRecord): { artifactId: string; revisionId: string } {
  return row.linkedArtifactId
    ? { artifactId: row.linkedArtifactId, revisionId: row.linkedRevisionId ?? '' }
    : { artifactId: `${ARTIFACT_PREFIX.runEvent}${row.artifactKey}`, revisionId: `${row.artifactKey}:1` };
}

/**
 * Insert-only write (replay-safe) + return the CANONICAL result. On a CAS loss (a concurrent
 * re-exec wrote first), re-read and return the WINNER's id so both callers agree on one
 * artifactId — never two ids for the same key. (A losing media mint leaves orphaned bytes;
 * best-effort, rare, storage-only.)
 */
async function writeRow(input: PersistRunArtifactInput, row: Partial<RunArtifactRecord> & { artifactKey: string }): Promise<{ artifactId: string; revisionId: string }> {
  const full: RunArtifactRecord = stripSecretsFromPersisted({
    artifactKey: row.artifactKey,
    tenantId: input.tenantId,
    orgId: input.tenantId,
    runId: input.runId,
    nodeId: input.nodeId,
    role: input.role,
    title: row.title ?? `${input.nodeId} output`,
    kind: row.kind ?? 'data',
    format: row.format ?? 'application/json',
    status: input.role === 'deliverable' ? 'final' : 'in-review',
    content: row.content ?? '',
    ...(row.artifactTypeId ? { artifactTypeId: row.artifactTypeId } : {}),
    createdBy: input.runId,
    createdAt: input.now,
    ...(row.linkedArtifactId ? { linkedArtifactId: row.linkedArtifactId } : {}),
    ...(row.linkedRevisionId ? { linkedRevisionId: row.linkedRevisionId } : {}),
  });
  const won = await runArtifacts.compareAndSwap(null, full);
  if (won) return resultFor(full);
  const winner = await runArtifacts.get(row.artifactKey);
  return winner ? resultFor(winner) : resultFor(full);
}

/** Mint a `media:` artifact from inline base64 bytes (so it previews as real bytes). */
async function mintMedia(input: PersistRunArtifactInput, b64: MediaBytes): Promise<{ artifactId: string; revisionId: string } | null> {
  const estBytes = Math.floor((b64.contentBase64.length * 3) / 4);
  await assertOrgCapacity(input.tenantId, input.tenantId, estBytes); // throws if over org quota → caller catches
  const stored = await putMediaBytes(input.tenantId, { contentBase64: b64.contentBase64, contentType: b64.contentType });
  const asset = await createAsset({
    tenantId: input.tenantId,
    orgId: input.tenantId,
    name: `${input.nodeId}-${b64.name}.${extOf(b64.contentType)}`,
    contentType: b64.contentType,
    sizeBytes: stored.sizeBytes,
    storageRef: stored.storageRef,
    serveToken: stored.serveToken,
    uploadedBy: input.runId,
  });
  return { artifactId: `${ARTIFACT_PREFIX.media}${asset.assetId}`, revisionId: `${asset.assetId}:1` };
}

/** Mint a media asset for `b64` + record an idempotent bookkeeping row under `key` linking it.
 *  Get-first (no re-mint on retry); GCs the orphaned asset on a CAS loss. */
async function mintAndLink(input: PersistRunArtifactInput, key: string, b64: MediaBytes): Promise<{ artifactId: string; revisionId: string } | null> {
  const existing = await getRunArtifact(key);
  if (existing) {
    return existing.linkedArtifactId
      ? { artifactId: existing.linkedArtifactId, revisionId: existing.linkedRevisionId ?? '' }
      : { artifactId: `${ARTIFACT_PREFIX.runEvent}${key}`, revisionId: `${key}:1` };
  }
  const minted = await mintMedia(input, b64);
  if (!minted) return null;
  const stored = await writeRow(input, { artifactKey: key, linkedArtifactId: minted.artifactId, linkedRevisionId: minted.revisionId });
  if (stored.artifactId !== minted.artifactId) {
    // ART-3 — we lost the insert-only CAS race; GC the asset we minted. Log on failure
    // (previously swallowed → an orphaned asset with no trail).
    await deleteAsset(input.tenantId, input.tenantId, minted.artifactId.slice(ARTIFACT_PREFIX.media.length))
      .catch((err) => log.warn('run_artifact_cas_loss_gc_failed', {
        tenantId: input.tenantId, assetId: minted.artifactId, error: err instanceof Error ? err.message : String(err),
      }));
  }
  return stored;
}

/**
 * Persist a node output as a durable artifact (idempotent, replay-safe, best-effort).
 * Returns the artifactId (a `media:`/`document:` owner when the output references one, else a
 * `run-event:` id) + its revision, or null on empty/failure (callers MUST NOT abort the run).
 */
export async function persistRunArtifact(input: PersistRunArtifactInput): Promise<PersistResult> {
  try {
    if (input.output === undefined || input.output === null) return null;
    const artifactKey = runArtifactKey(input.runId, input.nodeId);

    // Idempotency/replay-safety is enforced PER-KEY inside each branch (writeRow's insert-only
    // CAS returns the winner; mintAndLink get-firsts), NOT a single top-of-fn short-circuit —
    // so a re-exec is a no-op AND a multi-image run that crashed mid-loop RESUMES any extras it
    // hadn't captured (review LOW-1). Re-running detection on a re-exec is cheap.
    const value = unwrap(input.output);

    // 1) DOCUMENT reference → link the existing document: artifact (no dup, no blob).
    const docId = detectDocumentRef(value);
    if (docId) {
      const doc = await getDocumentByIdForTenant(input.tenantId, docId);
      if (doc) {
        const linkedArtifactId = `${ARTIFACT_PREFIX.document}${docId}`;
        const linkedRevisionId = doc.currentVersionId ?? '';
        return await writeRow(input, { artifactKey, linkedArtifactId, ...(linkedRevisionId ? { linkedRevisionId } : {}) });
      }
      // unresolvable doc → fall through to inline
    }

    // 2) INLINE BINARY → mint a media: artifact per asset (preview real bytes). A multi-image
    //    generator captures EVERY image (ADR 0083 #3): the primary keyed `${runId}:${nodeId}`,
    //    extras at `${runId}:${nodeId}#i` — all surface in the Library; the interrupt binding
    //    uses the primary. (mintAndLink get-firsts the bookkeeping row, so a re-exec re-mints none.)
    const b64s = detectBase64All(value);
    if (b64s.length > 0) {
      try {
        const primary = await mintAndLink(input, artifactKey, b64s[0]!);
        for (let i = 1; i < b64s.length; i++) await mintAndLink(input, `${artifactKey}#${i}`, b64s[i]!);
        if (primary) return primary;
      } catch (err) {
        // Over quota / store failure — skip rather than inline megabytes of base64 garbage.
        log.warn('run_artifact_media_mint_failed', { runId: input.runId, nodeId: input.nodeId, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }

    // 3) SERVE reference (URL-based image array → ADR 0115). The image-generate node emits
    //    `images: [{ url }]` (bytes already a media asset); capture EVERY image as a
    //    file artifact (primary keyed `${runId}:${nodeId}`, extras at `#i`) so the
    //    Library/workbench previews the images, not a JSON blob. Replay-safe (writeRow is
    //    insert-only on the deterministic key).
    const serveAll = detectServeRefAll(value);
    if (serveAll.length > 0) {
      const primary = await writeRow(input, { artifactKey, content: `[${serveAll[0]!.name}](${serveAll[0]!.serveUrl})`, kind: 'file', format: 'text/markdown', title: serveAll[0]!.name });
      for (let i = 1; i < serveAll.length; i++) {
        await writeRow(input, { artifactKey: `${artifactKey}#${i}`, content: `[${serveAll[i]!.name}](${serveAll[i]!.serveUrl})`, kind: 'file', format: 'text/markdown', title: serveAll[i]!.name });
      }
      return primary;
    }

    // 3b) SINGLE serve reference → a run-event artifact whose content is a click-to-open link.
    const serveRef = detectServeRef(value);
    if (serveRef) {
      return await writeRow(input, { artifactKey, content: `[${serveRef.name}](${serveRef.serveUrl})`, kind: 'file', format: 'text/markdown', title: serveRef.name });
    }

    // 3c) TYPED INLINE ARTIFACT (ADR 0055/0128) — a node that declared its artifact
    //     type (interactive.*, code.execution-result) persists with that type + its
    //     payload as content, so the workbench renderer (which dispatches on
    //     artifactTypeId) receives it. After the doc/media/serve paths so a real
    //     document/asset still links; replay-safe (writeRow insert-only).
    const typed = detectTypedArtifact(value, input.nodeId);
    if (typed) {
      const tContent = typed.content.length > MAX_INLINE_BYTES
        ? `${typed.content.slice(0, MAX_INLINE_BYTES)}\n\n…[truncated]`
        : typed.content;
      if (tContent.length === 0) return null;
      return await writeRow(input, { artifactKey, content: tContent, kind: typed.kind, format: typed.format, title: typed.title, artifactTypeId: typed.artifactTypeId });
    }

    // 4) INLINE CONTENT (text/markdown/json), size-capped.
    const derived = deriveArtifact(value, input.nodeId);
    const content = derived.content.length > MAX_INLINE_BYTES
      ? `${derived.content.slice(0, MAX_INLINE_BYTES)}\n\n…[truncated]`
      : derived.content;
    if (content.length === 0) return null;
    return await writeRow(input, { artifactKey, content, kind: derived.kind, format: derived.format, title: derived.title });
  } catch (err) {
    log.warn('run_artifact_persist_failed', { runId: input.runId, nodeId: input.nodeId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Read one run-artifact by its key. */
export async function getRunArtifact(artifactKey: string): Promise<RunArtifactRecord | null> {
  return runArtifacts.get(artifactKey);
}

/** Inline (non-link) run-artifacts for a tenant, newest first. Link/bookkeeping rows are
 *  EXCLUDED — their canonical artifact is the linked media:/document: owner (listed there). */
export async function listRunArtifactsForTenant(tenantId: string): Promise<RunArtifactRecord[]> {
  return (await runArtifacts.list())
    .filter((a) => a.tenantId === tenantId && !a.linkedArtifactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Test-only — clear the store. */
export async function __resetRunArtifactStore(): Promise<void> {
  await runArtifacts.__clear();
}
