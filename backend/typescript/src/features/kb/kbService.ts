/**
 * Knowledge Base / RAG (ADR 0011). Org-scoped, tenant+org IDOR-guarded. Owns
 * collections + documents (durable) and an ingest→chunk→embed→index pipeline +
 * semantic retrieval with citations. It COMPOSES existing host surfaces rather
 * than reinventing them:
 *   - the vector store via `buildHostSurfaceBundle({tenantId}).db.vector`
 *     (in-memory brute-force ↔ pgvector, tenant-scoped automatically);
 *   - the deterministic `embedText` embedder (no provider needed, replay-safe).
 *
 * Chunks are DERIVED, not separately stored: the document's `text` is the durable
 * source of truth, and because `embedText` is deterministic, the vector namespace
 * is lazily REBUILT from durable documents on first access per process (`hydrate`)
 * — restart-safe (the in-memory vector surface is ephemeral) without persisting
 * 256-float blobs per chunk. The host vector store still runs the similarity query.
 *
 * @see docs/adr/0011-knowledge-base-rag.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { buildHostSurfaceBundle } from '../../host/inMemorySurfaces.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../../aiProviders/localEmbedding.js';
import { bm25Search, rrfFuse } from './lexicalIndex.js';
import { localRerank } from './reranker.js';

/** Retrieval pipeline mode (ADR 0113). `dense` = today's single-stage cosine
 *  (default, unchanged). `hybrid` = BM25 + dense fused with RRF (deterministic,
 *  replay-safe). `hybrid+rerank` adds a rerank stage (Phase 2). */
export type RetrievalMode = 'dense' | 'hybrid' | 'hybrid+rerank';
const DEFAULT_RRF_K = 60;
const HYBRID_CANDIDATES = 24; // per-channel candidate pool before fusion/truncation
import { resolveHeadlessAi } from '../../host/headlessAi.js';
import type { ChatMessage, ContentPart } from '../../providers/dispatch.js';
import { checkMediaBudget, recordMediaUsage } from '../../aiProviders/mediaBudget.js';
import { AUDIO_TRANSCRIPTION_SYSTEM_PROMPT, AUDIO_TRANSCRIPTION_USER_PROMPT } from '../../aiProviders/mediaTranscriptionPrompts.js';
import { createLogger } from '../../observability/logger.js';
import type { KnowledgeRetrieveArgs, KnowledgeResult } from '../../host/knowledgeSurface.js';

const log = createLogger('features.kb');

const MAX = {
  name: 160,
  description: 1000,
  title: 200,
  /** Per-document source text. Bounded — the whole blob is stored durably. Sized to hold a
   *  full long-audio transcript (a ~64k-token output ≈ ~260k chars; ADR 0111 review) so the
   *  durable cap doesn't truncate below what the model produced. */
  text: 400_000,
  query: 2000,
  perOrgCollections: 500,
  perCollectionDocs: 1000,
  topK: 50,
  /** Max collections a single tenant-wide retrieve fans out across (ctx.knowledge
   *  / ctx.features.kb.retrieve). Bounds the per-call work on the workflow hot
   *  path — a tenant with thousands of collections can't make one retrieve scan
   *  them all. Truncation is logged, not silent. */
  retrieveCollections: 50,
  /** Chunking: ~chars per chunk + overlap. Char-window with sentence-ish
   *  boundary preference; deterministic so re-chunk on hydrate is identical.
   *  NOTE: changing these re-chunks documents — on a PERSISTED vector backend
   *  (pgvector) a collection ingested under the old params needs a re-index
   *  (delete + re-ingest) to avoid stale id↔text pairing. The default in-memory
   *  surface re-derives the whole namespace each process, so it's self-consistent. */
  chunkChars: 1200,
  chunkOverlap: 150,
  chunksPerDoc: 1000,
} as const;

/** Text-like MIME types we can extract from a Media asset. Binary/complex
 *  formats (PDF/Office) are deferred (ADR open question). */
const TEXT_MIME = /^(text\/|application\/(json|xml|x-ndjson|markdown)$)/i;

export interface KnowledgeCollection {
  collectionId: string;
  tenantId: string;
  orgId: string;
  name: string;
  description?: string;
  documentCount: number;
  chunkCount: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when the collection is AUTO-MANAGED by another feature that keeps it in
   * sync with its own entities (ADR 0100) — e.g. `'strategy'` mirrors the org's
   * shared strategies, `'priority-matrix'` its ideas. A managed collection is
   * fed only through `upsertDocument`/`deleteDocument` by its owning feature;
   * the KB routes REJECT hand-edits on it (so the UI's read-only treatment is
   * enforced server-side, not just hidden). Absent on user-created collections.
   */
  managed?: 'strategy' | 'priority-matrix';
  /** ADR 0113 — per-collection retrieval pipeline config. Absent ⇒ the env
   *  default (`OPENWOP_KB_RETRIEVAL_MODE`, itself defaulting to `dense`). */
  retrievalConfig?: RetrievalConfig;
}

/** ADR 0113 retrieval config — `mode` is the user-facing lever; the optional
 *  rerank sub-config selects the local (default) vs external (Phase 4) reranker. */
export interface RetrievalConfig {
  mode?: RetrievalMode;
  rerank?: { kind: 'local' | 'connection'; connectionId?: string; topN?: number };
}

/** The env-level default retrieval mode (a host operator can lift the floor for
 *  all collections without per-collection edits). Defaults to today's `dense`. */
function envDefaultMode(): RetrievalMode {
  const v = process.env.OPENWOP_KB_RETRIEVAL_MODE;
  return v === 'hybrid' || v === 'hybrid+rerank' ? v : 'dense';
}

/** Resolve the effective retrieval mode for a collection: per-collection config
 *  wins, else the env default. */
export function resolveRetrievalMode(col: Pick<KnowledgeCollection, 'retrievalConfig'>): RetrievalMode {
  return col.retrievalConfig?.mode ?? envDefaultMode();
}

// A document records HOW it was sourced, but NOT the media capability token: the
// token is a credential, and the text is already extracted durably, so storing
// it would leak asset access to any workspace:read member who lists documents
// (and it has no post-ingest value — media assets are immutable token-addressed
// blobs). Provenance is the kind only.
export type DocSource = { kind: 'text' } | { kind: 'media' };

export interface KnowledgeDocument {
  documentId: string;
  collectionId: string;
  tenantId: string;
  orgId: string;
  title: string;
  source: DocSource;
  /** Content-trust provenance (RFC 0021 / ADR 0038 §C). `'untrusted'` for
   *  provider/trigger-derived content (Google Drive import, webhook/email/form
   *  auto-ingest) AND for any FILE/media upload — extracted content is never
   *  human-reviewed, so hidden/adversarial text can't be injected agent-trusted
   *  (ADR 0108 review hardening). `'trusted'` only for directly-pasted text.
   *  Absent on docs stored before this field ⇒ treated as `'trusted'`. Carried
   *  onto every chunk so dispatch can fence untrusted content. */
  contentTrust?: 'trusted' | 'untrusted';
  /** The durable source of truth; chunks are re-derived from this. */
  text: string;
  chunkCount: number;
  createdBy: string;
  createdAt: string;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  chunkIndex: number;
  text: string;
  score: number;
  contentTrust: 'trusted' | 'untrusted';
}

const collections = new DurableCollection<KnowledgeCollection>('kb:collection', (c) => `${c.tenantId}:${c.orgId}:${c.collectionId}`);
const documents = new DurableCollection<KnowledgeDocument>('kb:document', (d) => `${d.tenantId}:${d.orgId}:${d.documentId}`);

/** Vector namespaces rebuilt this process-lifetime, keyed `${tenantId}:${collectionId}`.
 *  The in-memory vector surface is ephemeral; the first access after a restart
 *  re-derives the namespace from durable documents (deterministic embedder). */
const hydrated = new Set<string>();

// ─── chunking (deterministic) ──────────────────────────────────────────────

/** Split `text` into overlapping char windows, preferring to break on a
 *  paragraph/sentence boundary near the window edge. Deterministic: the same
 *  text always yields the same chunks (so re-chunk on hydrate matches ingest). */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length === 0) return [];
  const out: string[] = [];
  let pos = 0;
  while (pos < clean.length && out.length < MAX.chunksPerDoc) {
    let end = Math.min(pos + MAX.chunkChars, clean.length);
    if (end < clean.length) {
      // Prefer a boundary (paragraph, then sentence, then space) in the last
      // ~20% of the window so chunks don't split mid-sentence.
      const windowStart = pos + Math.floor(MAX.chunkChars * 0.8);
      const slice = clean.slice(windowStart, end);
      const para = slice.lastIndexOf('\n\n');
      const sent = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
      const space = slice.lastIndexOf(' ');
      const rel = para >= 0 ? para : sent >= 0 ? sent + 1 : space;
      if (rel >= 0) end = windowStart + rel + 1;
    }
    const chunk = clean.slice(pos, end).trim();
    if (chunk.length > 0) out.push(chunk);
    if (end >= clean.length) break;
    pos = Math.max(end - MAX.chunkOverlap, pos + 1);
  }
  return out;
}

function vectorSurface(tenantId: string) {
  return buildHostSurfaceBundle({ tenantId }).db.vector;
}

interface ChunkRow { id: string; vector: number[]; metadata: { documentId: string; chunkIndex: number; title: string; text: string; contentTrust: 'trusted' | 'untrusted' } }

/** Build the chunk rows for one document (deterministic ids + vectors). Carries
 *  the document's content-trust onto every chunk (ADR 0038 §C) so retrieval +
 *  dispatch can fence untrusted content. */
function chunkRows(doc: KnowledgeDocument): ChunkRow[] {
  const contentTrust = doc.contentTrust === 'untrusted' ? 'untrusted' : 'trusted';
  return chunkText(doc.text).map((text, chunkIndex) => ({
    id: `${doc.documentId}:${chunkIndex}`,
    vector: embedText(text, DEFAULT_EMBEDDING_DIMS),
    metadata: { documentId: doc.documentId, chunkIndex, title: doc.title, text, contentTrust },
  }));
}

/** Just the chunk ids for a document — for vector DELETE, which doesn't need the
 *  (expensive) embeddings `chunkRows` computes. */
function chunkIds(doc: KnowledgeDocument): string[] {
  return chunkText(doc.text).map((_text, i) => `${doc.documentId}:${i}`);
}

/** Chunk rows WITHOUT the (expensive) embedding — the lexical/BM25 channel + the
 *  fusion metadata lookup need only `{id, text, trust, …}`, not the vector (ADR
 *  0113). Same ids + same durable text as `chunkRows`, so the two channels agree. */
function chunkMetaRows(doc: KnowledgeDocument): Array<{ id: string; metadata: ChunkRow['metadata'] }> {
  const contentTrust = doc.contentTrust === 'untrusted' ? 'untrusted' : 'trusted';
  return chunkText(doc.text).map((text, chunkIndex) => ({
    id: `${doc.documentId}:${chunkIndex}`,
    metadata: { documentId: doc.documentId, chunkIndex, title: doc.title, text, contentTrust },
  }));
}

/** The collection's chunk corpus (metadata-only) for the lexical channel — the
 *  SAME durable chunk text `hydrate` feeds the dense channel (no parallel corpus). */
async function collectionChunks(tenantId: string, orgId: string, collectionId: string): Promise<Array<{ id: string; metadata: ChunkRow['metadata'] }>> {
  const docs = (await documents.list()).filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId);
  return docs.flatMap(chunkMetaRows);
}

/** Lazily rebuild a collection's vector namespace from its durable documents,
 *  once per process. Cheap re-embed (deterministic) — no vectors are persisted. */
async function hydrate(tenantId: string, orgId: string, collectionId: string): Promise<void> {
  const key = `${tenantId}:${collectionId}`;
  if (hydrated.has(key)) return;
  const docs = (await documents.list()).filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId);
  const rows = docs.flatMap(chunkRows);
  if (rows.length > 0) {
    await vectorSurface(tenantId).upsert({ namespace: collectionId, items: rows });
  }
  hydrated.add(key);
}

// ─── collections ───────────────────────────────────────────────────────────

export async function listCollections(tenantId: string, orgId: string): Promise<KnowledgeCollection[]> {
  return (await collections.list())
    .filter((c) => c.tenantId === tenantId && c.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Every collection in a tenant, ACROSS its orgs (newest-first). Used by the
 *  `agent-knowledge` feature (ADR 0038) to resolve a bound collectionId back to
 *  its owning org — bindings store only the id (the ADR data model), and KB keys
 *  are tenant+org+collection. Tenant-scoped (CTI-1); no org filter. */
export async function listAllTenantCollections(tenantId: string): Promise<KnowledgeCollection[]> {
  return (await collections.list())
    .filter((c) => c.tenantId === tenantId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getCollection(tenantId: string, orgId: string, collectionId: string): Promise<KnowledgeCollection | null> {
  const c = await collections.get(`${tenantId}:${orgId}:${collectionId}`);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

export async function createCollection(
  tenantId: string,
  orgId: string,
  actor: string,
  input: { name?: unknown; description?: unknown; collectionId?: string; managed?: 'strategy' | 'priority-matrix' },
): Promise<KnowledgeCollection> {
  const existing = (await collections.list()).filter((c) => c.tenantId === tenantId && c.orgId === orgId);
  if (existing.length >= MAX.perOrgCollections) {
    throw new OpenwopError('validation_error', `Collection cap reached (${MAX.perOrgCollections}).`, 400, {});
  }
  const now = new Date().toISOString();
  const col: KnowledgeCollection = {
    // A caller MAY supply a deterministic `collectionId` (ADR 0100 managed
    // collections resolve theirs by point-lookup, no scan); user-created
    // collections get a random one.
    collectionId: typeof input.collectionId === 'string' && input.collectionId.length > 0 ? input.collectionId : randomUUID(),
    tenantId,
    orgId,
    name: cleanString(input.name, MAX.name),
    ...(optionalCleanString(input.description, MAX.description) !== undefined ? { description: optionalCleanString(input.description, MAX.description) } : {}),
    documentCount: 0,
    chunkCount: 0,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
    ...(input.managed ? { managed: input.managed } : {}),
  };
  if (col.name.length === 0) throw new OpenwopError('validation_error', 'Field `name` is required.', 400, { field: 'name' });
  await collections.put(col);
  return col;
}

/** ADR 0113 Phase 3 — set a collection's retrieval pipeline config (mode + the
 *  local-rerank toggle). `mode:'dense'` restores today's behavior. The external
 *  (`connection`) reranker is NOT accepted here until Phase 4 wires the
 *  record-and-replay path — only `local` is honored. */
export async function setRetrievalConfig(
  tenantId: string,
  orgId: string,
  collectionId: string,
  actor: string,
  input: { mode?: unknown; rerank?: unknown },
): Promise<KnowledgeCollection> {
  const col = await mustGetCollection(tenantId, orgId, collectionId);
  const mode = input.mode;
  if (mode !== undefined && mode !== 'dense' && mode !== 'hybrid' && mode !== 'hybrid+rerank') {
    throw new OpenwopError('validation_error', '`mode` MUST be one of dense | hybrid | hybrid+rerank.', 400, { field: 'mode' });
  }
  const cfg: RetrievalConfig = {};
  if (mode) cfg.mode = mode;
  const rerank = input.rerank as { kind?: unknown } | undefined;
  if (rerank && rerank.kind === 'local') cfg.rerank = { kind: 'local' };
  col.retrievalConfig = cfg;
  col.updatedAt = new Date().toISOString();
  col.updatedBy = actor;
  await collections.put(col);
  return col;
}

export async function deleteCollection(tenantId: string, orgId: string, collectionId: string): Promise<void> {
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  const docs = (await documents.list()).filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId);
  // Clear the vector namespace (the chunk ids of every doc) then drop the docs.
  const ids = docs.flatMap(chunkIds);
  if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: collectionId, ids });
  for (const d of docs) await documents.delete(`${tenantId}:${orgId}:${d.documentId}`);
  await collections.delete(`${tenantId}:${orgId}:${collectionId}`);
  hydrated.delete(`${tenantId}:${collectionId}`);
}

// ─── documents (ingest) ──────────────────────────────────────────────────

export async function listDocuments(tenantId: string, orgId: string, collectionId: string): Promise<Array<Omit<KnowledgeDocument, 'text'>>> {
  await mustGetCollection(tenantId, orgId, collectionId);
  return (await documents.list())
    .filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    // Drop the (potentially large) full text from the list projection.
    .map(({ text: _text, ...rest }) => rest);
}

export async function getDocument(tenantId: string, orgId: string, collectionId: string, documentId: string): Promise<KnowledgeDocument | null> {
  const d = await documents.get(`${tenantId}:${orgId}:${documentId}`);
  return d && d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId ? d : null;
}

/**
 * Ingest pasted text OR a Media-asset token into a collection: resolve the
 * source text, chunk → embed → upsert to the collection's vector namespace, and
 * store the document (with its durable text) + bump counts.
 */
export async function ingestDocument(
  tenantId: string,
  orgId: string,
  actor: string,
  collectionId: string,
  input: { title?: unknown; text?: unknown; mediaToken?: unknown; contentBase64?: unknown; contentType?: unknown; contentTrust?: 'trusted' | 'untrusted'; documentId?: string },
): Promise<Omit<KnowledgeDocument, 'text'>> {
  const col = await mustGetCollection(tenantId, orgId, collectionId);
  const docCount = (await documents.list()).filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId).length;
  if (docCount >= MAX.perCollectionDocs) {
    throw new OpenwopError('validation_error', `Document cap reached (${MAX.perCollectionDocs}).`, 400, {});
  }

  const { text, source, derivedTitle } = await resolveSource(tenantId, input);
  const title = cleanString(input.title, MAX.title) || derivedTitle || 'Untitled';

  const doc: KnowledgeDocument = {
    // A caller MAY supply a STABLE `documentId` (ADR 0100 keys a managed doc by
    // its source entity's id so re-index is a deterministic delete+re-ingest);
    // otherwise a random id.
    documentId: typeof input.documentId === 'string' && input.documentId.length > 0 ? input.documentId : randomUUID(),
    collectionId,
    tenantId,
    orgId,
    title,
    source,
    // Content extracted from an uploaded FILE or media token is never human-reviewed —
    // a PDF/DOCX can hide white-on-white or off-screen text, and an image/audio can carry
    // adversarial text the uploader never saw (the parser/vision-LLM surfaces it). So
    // binary-sourced content (source.kind === 'media') is fenced UNTRUSTED regardless of
    // the caller; only directly-pasted text (kind === 'text') may be trusted. This aligns
    // KB upload with what notebooks/sync already do (RFC 0021 / ADR 0038 §C; ADR 0108 review).
    contentTrust: source.kind === 'media' ? 'untrusted' : (input.contentTrust === 'untrusted' ? 'untrusted' : 'trusted'),
    text,
    chunkCount: 0,
    createdBy: actor,
    createdAt: new Date().toISOString(),
  };
  const rows = chunkRows(doc);
  doc.chunkCount = rows.length;

  await hydrate(tenantId, orgId, collectionId); // ensure the namespace exists before adding
  // Durable doc FIRST, then the (ephemeral) vectors — so a crash between the two
  // never leaves orphan vectors without a backing document. If the upsert fails,
  // drop the hydrate marker: the next search rebuilds the namespace from durable
  // docs (which now includes this one), so the doc self-heals into searchability.
  await documents.put(doc);
  if (rows.length > 0) {
    try {
      await vectorSurface(tenantId).upsert({ namespace: collectionId, items: rows });
    } catch (err) {
      hydrated.delete(`${tenantId}:${collectionId}`);
      throw err;
    }
  }

  col.documentCount += 1;
  col.chunkCount += rows.length;
  col.updatedAt = doc.createdAt;
  col.updatedBy = actor;
  await collections.put(col);

  const { text: _t, ...projection } = doc;
  return projection;
}

export async function deleteDocument(tenantId: string, orgId: string, collectionId: string, documentId: string): Promise<void> {
  const doc = await getDocument(tenantId, orgId, collectionId, documentId);
  if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId });
  const ids = chunkIds(doc);
  if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: collectionId, ids });
  await documents.delete(`${tenantId}:${orgId}:${documentId}`);
  const col = await getCollection(tenantId, orgId, collectionId);
  if (col) {
    col.documentCount = Math.max(0, col.documentCount - 1);
    col.chunkCount = Math.max(0, col.chunkCount - doc.chunkCount);
    col.updatedAt = new Date().toISOString();
    await collections.put(col);
  }
}

/**
 * Re-ingest a document under a STABLE caller-supplied id (ADR 0100): delete the
 * prior revision if present, then ingest fresh. Idempotent — keying by the
 * source entity's id means re-index is deterministic (no orphan/duplicate docs)
 * and tolerates a first-time index (no prior doc to delete). Used by the
 * planning-KB indexers; not exposed as a user route.
 */
export async function upsertDocument(
  tenantId: string,
  orgId: string,
  collectionId: string,
  documentId: string,
  actor: string,
  input: { title?: unknown; text?: unknown; contentTrust?: 'trusted' | 'untrusted' },
): Promise<Omit<KnowledgeDocument, 'text'>> {
  const prior = await getDocument(tenantId, orgId, collectionId, documentId);
  // Content-hash guard (ADR 0100 Phase 3): if the indexable content is unchanged,
  // skip the delete+re-ingest+re-embed entirely. Makes no-op updates (and backfill
  // re-runs) free. Compares the resolved text doc only (text-source upserts).
  if (prior) {
    const sameTitle = prior.title === (cleanString(input.title, MAX.title) || prior.title);
    const sameText = typeof input.text === 'string' && prior.text === input.text;
    if (sameText && sameTitle) {
      const { text: _t, ...projection } = prior;
      return projection;
    }
    await deleteDocument(tenantId, orgId, collectionId, documentId);
  }
  return ingestDocument(tenantId, orgId, actor, collectionId, { ...input, documentId });
}

// ─── retrieval ───────────────────────────────────────────────────────────

export async function search(tenantId: string, orgId: string, collectionId: string, queryRaw: unknown, topKRaw: unknown, mode: RetrievalMode = 'dense'): Promise<SearchHit[]> {
  await mustGetCollection(tenantId, orgId, collectionId);
  const query = cleanString(queryRaw, MAX.query);
  if (query.length === 0) throw new OpenwopError('validation_error', 'Field `query` is required.', 400, { field: 'query' });
  const topK = clampTopK(topKRaw);
  await hydrate(tenantId, orgId, collectionId);

  // Dense channel (always) — for hybrid, pull a wider candidate pool so fusion
  // has something to reorder.
  const denseK = mode === 'dense' ? topK : Math.max(topK, HYBRID_CANDIDATES);
  const res = await vectorSurface(tenantId).query({ namespace: collectionId, vector: embedText(query, DEFAULT_EMBEDDING_DIMS), topK: denseK });
  const matches = (res.matches ?? []) as Array<{ id: string; score: number; metadata?: ChunkRow['metadata'] }>;
  const denseHits: SearchHit[] = matches.map((m) => ({
    chunkId: m.id,
    documentId: m.metadata?.documentId ?? '',
    title: m.metadata?.title ?? '',
    chunkIndex: m.metadata?.chunkIndex ?? 0,
    text: m.metadata?.text ?? '',
    score: m.score,
    contentTrust: m.metadata?.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
  }));
  if (mode === 'dense') return denseHits.slice(0, topK);

  // Lexical (BM25) channel over the SAME durable chunk text, then RRF-fuse the two
  // ranked lists (ADR 0113). Deterministic ⇒ replay-safe, nothing recorded. The
  // metadata for every chunk (text/title/trust) comes from the corpus map, so a
  // lexical-only hit (no dense match) is still fully projected — with its trust.
  const corpus = await collectionChunks(tenantId, orgId, collectionId);
  const metaById = new Map(corpus.map((r) => [r.id, r.metadata]));
  const lexical = bm25Search(corpus.map((r) => ({ id: r.id, text: r.metadata.text })), query, HYBRID_CANDIDATES);
  // Fuse into a WIDER candidate pool; truncation to top-k happens after the
  // optional rerank stage (so rerank can promote a candidate past the cut).
  const fused = rrfFuse([denseHits.map((h) => ({ id: h.chunkId })), lexical], DEFAULT_RRF_K, HYBRID_CANDIDATES);
  const candidates: SearchHit[] = fused.map((f) => {
    const m = metaById.get(f.id);
    return {
      chunkId: f.id,
      documentId: m?.documentId ?? '',
      title: m?.title ?? '',
      chunkIndex: m?.chunkIndex ?? 0,
      text: m?.text ?? '',
      score: f.score,
      contentTrust: m?.contentTrust === 'untrusted' ? 'untrusted' : 'trusted',
    };
  });

  // Phase 2 — local DETERMINISTIC rerank over the fused candidates (replay-safe).
  if (mode === 'hybrid+rerank') {
    const byId = new Map(candidates.map((c) => [c.chunkId, c]));
    const reranked = localRerank(query, candidates.map((c) => ({ id: c.chunkId, text: c.text, title: c.title })), topK);
    return reranked.map((r) => ({ ...byId.get(r.id)!, score: r.score }));
  }
  return candidates.slice(0, topK);
}

/**
 * Back the tenant-scoped `ctx.knowledge` host surface (ADR 0014 Phase 0) with the
 * REAL KB store: vector-search across the tenant's collections and project to the
 * KnowledgeSurface chunk/source shape. Returns `null` (→ seeded demo fallback)
 * when KB is disabled for the tenant OR the tenant has no collections — so the
 * out-of-box demo still works and the surface only serves real data when there
 * is some. Closes the ADR-0011 "back host.knowledge with the real store" question.
 */
export async function tenantRetrieve(tenantId: string, args: KnowledgeRetrieveArgs): Promise<KnowledgeResult | null> {
  // KB is always-on (toggle removed); a tenant with no collections still falls
  // through to the demo path below.
  const tenantCollections = (await collections.list()).filter((c) => c.tenantId === tenantId);
  if (tenantCollections.length === 0) return null; // no real knowledge → demo fallback

  let wanted = args.collectionIds && args.collectionIds.length > 0
    ? tenantCollections.filter((c) => args.collectionIds!.includes(c.collectionId))
    : tenantCollections;
  if (wanted.length > MAX.retrieveCollections) {
    log.warn('kb_tenant_retrieve_truncated', { tenantId, total: wanted.length, cap: MAX.retrieveCollections });
    wanted = wanted.slice(0, MAX.retrieveCollections);
  }

  const started = Date.now();
  const resultLimit = clampTopK(args.resultLimit);
  const scoreThreshold = typeof args.scoreThreshold === 'number' ? args.scoreThreshold : 0;

  // Per-collection searches are independent → run them concurrently (wall-clock
  // is the slowest single search, not the sum). Each is fault-isolated to [].
  const perCollection = await Promise.all(
    wanted.map((c) =>
      search(tenantId, c.orgId, c.collectionId, args.query, Math.max(resultLimit, 8), resolveRetrievalMode(c))
        .then((hits) => hits.map((hit) => ({ hit, collectionId: c.collectionId })))
        .catch(() => [] as Array<{ hit: SearchHit; collectionId: string }>),
    ),
  );
  const scored = perCollection.flat();
  scored.sort((a, b) => b.hit.score - a.hit.score);

  const chunks: KnowledgeResult['chunks'] = scored
    .filter(({ hit }) => hit.score >= scoreThreshold)
    .slice(0, resultLimit)
    .map(({ hit, collectionId }) => ({
      chunkId: hit.chunkId,
      content: hit.text,
      headingPath: [],
      pageNumber: null,
      documentTitle: hit.title,
      assetId: hit.documentId,
      collectionId,
      relevanceScore: hit.score,
      contentTrust: hit.contentTrust,
    }));

  const sources: KnowledgeResult['sources'] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    if (!c.assetId || seen.has(c.assetId)) continue;
    seen.add(c.assetId);
    sources.push({ sourceId: c.assetId, assetId: c.assetId, title: c.documentTitle, headingPath: c.headingPath, pageNumber: c.pageNumber });
  }

  return { chunks, sources, latencyMs: Date.now() - started, hasResults: chunks.length > 0 };
}

export interface RagResult {
  query: string;
  contexts: SearchHit[];
  citations: Array<{ documentId: string; title: string }>;
  /** A grounded prompt assembled from the retrieved chunks, ready to feed to an
   *  agent / `ctx.callAI` IN A WORKFLOW. Generation is run-scoped (the provider
   *  is `ctx`-only), so the feature returns the augmented context, not an answer. */
  augmentedPrompt: string;
}

export async function ragQuery(tenantId: string, orgId: string, collectionId: string, queryRaw: unknown, topKRaw: unknown): Promise<RagResult> {
  const query = cleanString(queryRaw, MAX.query);
  const contexts = await search(tenantId, orgId, collectionId, queryRaw, topKRaw);
  const seen = new Set<string>();
  const citations: Array<{ documentId: string; title: string }> = [];
  for (const c of contexts) {
    if (c.documentId && !seen.has(c.documentId)) {
      seen.add(c.documentId);
      citations.push({ documentId: c.documentId, title: c.title });
    }
  }
  const contextBlock = contexts
    .map((c, i) => `[${i + 1}] (${c.title})\n${c.text}`)
    .join('\n\n');
  const augmentedPrompt = contexts.length === 0
    ? `No knowledge-base context was found for the question.\n\nQuestion: ${query}`
    : `Answer the question using ONLY the context below. Cite sources by their [n] index. If the context is insufficient, say so.\n\nContext:\n${contextBlock}\n\nQuestion: ${query}`;
  return { query, contexts, citations, augmentedPrompt };
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function mustGetCollection(tenantId: string, orgId: string, collectionId: string): Promise<KnowledgeCollection> {
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  return col;
}

function clampTopK(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 8;
  return Math.max(1, Math.min(n, MAX.topK));
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** Decoded-byte cap on an uploaded file before extraction — bounds the in-process
 *  parse (the 48mb body parser only bounds the request, not the decode). NOTE: this
 *  caps the COMPRESSED size of an OOXML/ODF file; a malicious zip can still expand
 *  large during parse — bounded only by per-request isolation (a bad file OOMs that
 *  request, never the store). Acceptable for the reference host. */
const MAX_UPLOAD_DECODED_BYTES = 32 * 1024 * 1024;
/** Audio gets a larger ceiling (ADR 0111) — long recordings go to the provider File API
 *  (dispatchGoogle) rather than inline, so they exceed the 32 MiB document cap. Still bounded
 *  (we hold the bytes to upload); matches dispatch's GEMINI_MAX_AUDIO_BYTES. */
const MAX_AUDIO_DECODED_BYTES = 200 * 1024 * 1024;
/** Transcription output budget (ADR 0111 review) — a long recording needs the model's full
 *  output window (~64k tokens ≈ several hours of speech); the 8k OCR default truncated it. */
const AUDIO_MAX_OUTPUT_TOKENS = 65536;
/** Transcription deadline (ADR 0111 review) — File-API upload + ACTIVE poll + a multi-minute
 *  generate exceeds the 120s dispatch default; give long audio room to finish. */
const AUDIO_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;

/** Formats routed to `officeparser` (lazy-imported) — PowerPoint, Excel, the
 *  OpenDocument trio, and RTF. PDF/DOCX keep their proven `unpdf`/`mammoth` paths. */
/** Image types OCR'd via the managed vision model when OPENWOP_KB_OCR_ENABLED=true. */
const OCR_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/tiff', 'image/gif']);
/** AUDIO types transcribed via the managed audio model when OPENWOP_KB_TRANSCRIBE_ENABLED=true.
 *  Gemini-accepted inline formats (dispatch.ts). Video is NOT here — it 415s (extract the
 *  audio track first), since `dispatch` has no inline-video path. */
const AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/aiff']);

const OFFICE_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',          // .xlsx
  'application/vnd.oasis.opendocument.text',                                    // .odt
  'application/vnd.oasis.opendocument.presentation',                            // .odp
  'application/vnd.oasis.opendocument.spreadsheet',                             // .ods
  'application/rtf', 'text/rtf',                                                // .rtf
]);

/**
 * Extract plain text from uploaded bytes by MIME — the SINGLE extraction owner for
 * file ingest (manual KB upload, media assets, and drive-sync). text/* + json/xml/
 * markdown decode as UTF-8; PDF via `unpdf`; DOCX via `mammoth`; PowerPoint / Excel /
 * OpenDocument / RTF via `officeparser` — all lazy-imported so the parsers stay off
 * the boot path. Anything with no extractable text (images, audio, video, archives)
 * throws 415 — honest: those don't tokenize into RAG without OCR/transcription, which
 * is a separate pipeline. A corrupt-but-right-type file throws 422 (that one ingest
 * fails; callers isolate it). Returns the extracted text (capped at MAX.text downstream).
 */
async function extractTextFromBytes(tenantId: string, buffer: Buffer, contentType: string): Promise<string> {
  const mime = contentType.toLowerCase().split(';')[0]!.trim();
  // RTF arrives as text/rtf but is NOT plain text — route it to officeparser FIRST,
  // before the text/* catch-all below.
  if (OFFICE_MIME.has(mime)) {
    try {
      const { parseOffice } = await import('officeparser');
      const parsed = await parseOffice(buffer);
      return parsed.toText();
    } catch (err) {
      throw new OpenwopError(
        'validation_error',
        `Could not extract text from the \`${contentType}\` file — it may be corrupt or password-protected.`,
        422,
        { contentType, reason: err instanceof Error ? err.message : String(err) },
      );
    }
  }
  if (TEXT_MIME.test(mime)) return buffer.toString('utf8');
  if (mime === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : text;
  }
  if (mime === DOCX_MIME) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  // Image OCR + audio transcription via the MANAGED multimodal provider (ADR 0108) — each
  // OFF by default behind its own env flag (they bill provider tokens). Off ⇒ 415 like any
  // un-tokenizable type. See `mediaToTextViaLLM` for the replay-safety contract.
  if (OCR_MIME.has(mime)) {
    if (process.env.OPENWOP_KB_OCR_ENABLED !== 'true') {
      throw new OpenwopError('validation_error', `Image OCR is not enabled on this host (\`${contentType}\`).`, 415, { contentType });
    }
    return mediaToTextViaLLM(tenantId, buffer, mime, 'image');
  }
  if (AUDIO_MIME.has(mime)) {
    if (process.env.OPENWOP_KB_TRANSCRIBE_ENABLED !== 'true') {
      throw new OpenwopError('validation_error', `Audio transcription is not enabled on this host (\`${contentType}\`).`, 415, { contentType });
    }
    // Pre-flight the per-org STT byte budget (ADR 0106) BEFORE the paid call; record after
    // a successful transcription. This byte budget is the PRIMARY audio cost control — the
    // resolver (ADR 0110) may route to a BYOK provider that has no managed daily token cap.
    // `buffer.length` IS the decoded byte count. On failure `mediaToTextViaLLM` throws, so
    // `recordMediaUsage` below never runs — no budget is consumed for a failed transcription.
    const budget = await checkMediaBudget(tenantId, 'stt', buffer.length);
    if (budget.exceeded) {
      throw new OpenwopError('rate_limited', `Daily transcription budget reached (${budget.cap} bytes; ${budget.used} used). Resets at 00:00 UTC.`, 429, { kind: 'stt', cap: budget.cap, used: budget.used });
    }
    const text = await mediaToTextViaLLM(tenantId, buffer, mime, 'audio');
    await recordMediaUsage(tenantId, 'stt', buffer.length);
    return text;
  }
  throw new OpenwopError(
    'validation_error',
    `Cannot extract text from \`${contentType}\` — supported: text/*, PDF, Word, PowerPoint, Excel, OpenDocument, RTF, and (when enabled) images (vision) + audio (transcription). Video transcription (extract the audio track first) and archives are not supported.`,
    415,
    { contentType },
  );
}

/** OCR an image by asking the host MANAGED provider's VISION model to read its text —
 *  in-service (like `cms/translate.ts`), so it composes the existing provider + its
 *  governance + daily usage cap (no local OCR engine). The image is fenced as untrusted
 *  later (ADR 0027); a non-vision managed model or a provider error maps to a clean 422. */
/**
 * Turn a media file into text by asking the host MANAGED provider's multimodal model —
 * IMAGE → vision OCR, AUDIO → speech transcription — in-service (the `cms/translate.ts`
 * pattern), composing the provider + its governance + daily usage cap (no local engine).
 *
 * REPLAY-UNSAFE BY DESIGN: a live provider call is non-deterministic on `:fork`. This is
 * only sound because every caller of `extractTextFromBytes` is a NON-recorded service op
 * (KB routes + the knowledge-sync runner) — NOT a recorded workflow run. The ctx
 * workflow-surface ingest ops STRUCTURALLY reject media `contentBase64` (see
 * `notebooksService.ingestSource`), so media only ever reaches here off a service path;
 * recorded-run transcription stays on the notebooks `transcribe-source` node (`ctx.callAI`).
 */
async function mediaToTextViaLLM(tenantId: string, buffer: Buffer, mime: string, kind: 'image' | 'audio'): Promise<string> {
  // Audio prompt is shared with callTranscriber (RFC 0106 §B) via the core constant so
  // the two managed-transcription paths can't drift; the OCR/image prompt stays local
  // (only kb does OCR).
  const system = kind === 'image'
    ? 'You are an OCR engine. Transcribe ALL text visible in the image verbatim, preserving reading order and line/table structure. Output ONLY the transcribed text — no commentary. If there is no text, output nothing.'
    : AUDIO_TRANSCRIPTION_SYSTEM_PROMPT;
  const part: ContentPart = kind === 'image'
    ? { type: 'image', mimeType: mime, dataBase64: buffer.toString('base64') }
    : { type: 'audio', mimeType: mime, dataBase64: buffer.toString('base64') };
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: kind === 'image' ? 'Transcribe the text in this image.' : AUDIO_TRANSCRIPTION_USER_PROMPT }, part] },
  ];
  // ADR 0110: resolve a capability-aware dispatch (managed-if-capable → tenant BYOK default
  // → null). On the reference host the managed target is MiniMax (text-only), so media
  // routes to the tenant's configured default AI provider; if none is capable, 422 honestly.
  const cap = kind === 'image' ? 'vision' : 'audio';
  const dispatch = await resolveHeadlessAi(tenantId, kind);
  if (!dispatch) {
    throw new OpenwopError('validation_error', `No ${cap}-capable AI provider is available for \`${mime}\`. Configure a default AI provider (with a ${cap}-capable model) in BYOK settings.`, 422, { contentType: mime });
  }
  try {
    // ADR 0111 review fix: a transcript can be FAR longer than OCR'd image text. An image's
    // text fits in 8k tokens; a long recording needs the model's full output budget (~64k) or
    // it truncates mid-transcript. Audio also runs through the File API (upload + ≤60s poll +
    // a multi-minute generate), so it needs a generous deadline well past the 120s dispatch
    // default — else it aborts before finishing.
    const opts = kind === 'audio'
      ? { maxTokens: AUDIO_MAX_OUTPUT_TOKENS, timeoutMs: AUDIO_DISPATCH_TIMEOUT_MS }
      : { maxTokens: 8192 };
    return await dispatch(messages, opts);
  } catch (err) {
    throw new OpenwopError('validation_error', `Could not ${kind === 'image' ? 'OCR' : 'transcribe'} the \`${mime}\` file.`, 422, { contentType: mime, reason: err instanceof Error ? err.message : String(err) });
  }
}

/** Resolve the document's source text from pasted text, uploaded bytes
 *  (`contentBase64`+`contentType`, extracted per-MIME), or a Media token — enforcing
 *  the tenant boundary on the asset. */
async function resolveSource(
  tenantId: string,
  input: { text?: unknown; mediaToken?: unknown; contentBase64?: unknown; contentType?: unknown },
): Promise<{ text: string; source: DocSource; derivedTitle?: string }> {
  // Direct file-upload path: bytes + MIME → extracted text (file upload to KBs).
  const contentBase64 = typeof input.contentBase64 === 'string' ? input.contentBase64 : '';
  const contentType = typeof input.contentType === 'string' ? input.contentType : '';
  if (contentBase64 && contentType) {
    // Guard BEFORE decoding + parsing (review fix): reject malformed base64 and cap
    // the DECODED size so a ~48 MB body can't drive an unbounded in-process
    // PDF/DOCX parse (a zip-bomb DOCX or pathological PDF is far worse than its
    // byte count). ~3/4 of the base64 length is the decoded byte count — cheap pre-check.
    if (!BASE64_RE.test(contentBase64) || contentBase64.length % 4 !== 0) {
      throw new OpenwopError('validation_error', 'Field `contentBase64` must be valid base64.', 400, { field: 'contentBase64' });
    }
    // Audio gets the larger cap (ADR 0111 — long-form transcription via the File API).
    const uploadCap = AUDIO_MIME.has(contentType.toLowerCase().split(';')[0]!.trim()) ? MAX_AUDIO_DECODED_BYTES : MAX_UPLOAD_DECODED_BYTES;
    if (Math.floor((contentBase64.length * 3) / 4) > uploadCap) {
      throw new OpenwopError('validation_error', `File exceeds the ${Math.round(uploadCap / (1024 * 1024))} MiB upload cap.`, 413, { maxBytes: uploadCap });
    }
    const extracted = await extractTextFromBytes(tenantId, Buffer.from(contentBase64, 'base64'), contentType);
    const text = extracted.slice(0, MAX.text);
    if (text.trim().length === 0) throw new OpenwopError('validation_error', 'No extractable text in the uploaded file.', 400, { contentType });
    return { text, source: { kind: 'media' } };
  }
  // NOT cleanString: a media token is a base64url capability credential that
  // legitimately looks secret-shaped, so `scrubSecretShaped` would redact it and
  // the lookup would 404. Validate the charset + length instead, no scrubbing.
  const mediaToken = typeof input.mediaToken === 'string' ? input.mediaToken.trim() : '';
  if (mediaToken) {
    if (mediaToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(mediaToken)) {
      throw new OpenwopError('validation_error', 'Invalid `mediaToken`.', 400, { field: 'mediaToken' });
    }
    const asset = await resolveMediaAsset(mediaToken);
    if (!asset || asset.tenantId !== tenantId) {
      throw new OpenwopError('not_found', 'Media asset not found.', 404, { mediaToken });
    }
    // Extract per-MIME (text/* + PDF + DOCX) — same path as a direct upload.
    const extracted = await extractTextFromBytes(tenantId, Buffer.from(asset.contentBase64, 'base64'), asset.contentType);
    const text = extracted.slice(0, MAX.text);
    if (text.trim().length === 0) throw new OpenwopError('validation_error', 'The media asset has no extractable text.', 400, {});
    return { text, source: { kind: 'media' } };
  }
  const text = cleanString(input.text, MAX.text);
  if (text.trim().length === 0) {
    throw new OpenwopError('validation_error', 'Provide `text`, a file upload, or a `mediaToken` to ingest.', 400, { field: 'text' });
  }
  return { text, source: { kind: 'text' } };
}
